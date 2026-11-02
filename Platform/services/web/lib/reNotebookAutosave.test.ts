import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { EntryAutosave, type AutosaveOptions, type AutosaveState } from "./reNotebookAutosave";
import type { NotebookEntry } from "./reNotebook";
import type { NotebookDoc } from "./reNotebookDoc";

function doc(text: string): NotebookDoc {
  return text
    ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
    : { type: "doc", content: [{ type: "paragraph" }] };
}

function entry(contentVersion: number): NotebookEntry {
  return {
    entryId: "e1", sectionId: "s1", title: "Entry", version: 1, contentVersion, textLength: 0,
    createdBy: "u", createdByName: "U", createdAt: "t0", updatedBy: "u", updatedByName: "U", updatedAt: `t${contentVersion}`,
    contentUpdatedBy: "u", contentUpdatedByName: "U", contentUpdatedAt: `t${contentVersion}`,
  };
}

interface Deferred {
  doc: NotebookDoc;
  expected: number;
  resolve: (e: NotebookEntry) => void;
  reject: (err: unknown) => void;
}

function setup(overrides: Partial<AutosaveOptions> = {}) {
  const calls: Deferred[] = [];
  const states: AutosaveState[] = [];
  const draft = { write: vi.fn(() => true), clear: vi.fn() };
  const onConflict = vi.fn();
  const onDeleted = vi.fn();
  const onSaved = vi.fn();
  const autosave = new EntryAutosave({
    doc: doc(""),
    contentVersion: 1,
    save: (d, expected) =>
      new Promise((resolve, reject) => {
        calls.push({ doc: d, expected, resolve, reject });
      }),
    onState: (s) => states.push(s),
    onSaved,
    onConflict,
    onDeleted,
    draft,
    ...overrides,
  });
  const last = () => states[states.length - 1];
  return { autosave, calls, states, last, draft, onConflict, onDeleted, onSaved };
}

/** Lets resolved promises' handlers run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("EntryAutosave", () => {
  it("saves 1.5 s after the last change, based on the loaded version", async () => {
    const t = setup();
    t.autosave.update(doc("a"));
    expect(t.last().status).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(1000);
    t.autosave.update(doc("ab"));
    await vi.advanceTimersByTimeAsync(1499);
    expect(t.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ doc: doc("ab"), expected: 1 });
    expect(t.last().status).toBe("saving");
    t.calls[0].resolve(entry(2));
    await settle();
    expect(t.last()).toMatchObject({ status: "saved", lastSavedAt: "t2" });
    expect(t.onSaved).toHaveBeenCalledWith(entry(2));
    expect(t.draft.clear).toHaveBeenCalled();
    expect(t.autosave.hasUnsaved()).toBe(false);
  });

  it("saves at least every 10 s while typing continues", async () => {
    const t = setup();
    for (let i = 1; i <= 10; i++) {
      t.autosave.update(doc("x".repeat(i)));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(t.calls).toHaveLength(1);
  });

  it("sends one save at a time and the next with the new version", async () => {
    const t = setup();
    t.autosave.update(doc("a"));
    await vi.advanceTimersByTimeAsync(1500);
    t.autosave.update(doc("ab")); // while saving
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.calls).toHaveLength(1);
    t.calls[0].resolve(entry(2));
    await settle();
    expect(t.last().status).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]).toMatchObject({ doc: doc("ab"), expected: 2 });
  });

  it("doesn't save when the change is undone", async () => {
    const t = setup();
    t.autosave.update(doc("a"));
    t.autosave.update(doc(""));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.calls).toHaveLength(0);
    expect(t.last().status).toBe("saved");
  });

  it("keeps a local draft of unsaved changes", async () => {
    const t = setup();
    t.autosave.update(doc("draft me"));
    await vi.advanceTimersByTimeAsync(400);
    expect(t.draft.write).toHaveBeenCalledWith(doc("draft me"), 1);
  });

  it("stops on a conflict without overwriting, and hands both versions over", async () => {
    const t = setup();
    t.autosave.update(doc("mine"));
    await vi.advanceTimersByTimeAsync(1500);
    t.calls[0].reject(new ApiError("changed", 409, { code: "conflict", doc: doc("theirs"), entry: entry(3) }));
    await settle();
    expect(t.last()).toMatchObject({ status: "conflict", stopped: true });
    expect(t.onConflict).toHaveBeenCalledWith(expect.objectContaining({ code: "conflict", doc: doc("theirs") }), doc("mine"));
    expect(t.draft.write).toHaveBeenLastCalledWith(doc("mine"), 1);
    t.autosave.update(doc("mine, more"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toHaveLength(1); // nothing sent until resolved
    expect(await t.autosave.flush()).toBe(false);

    // The user takes their version: autosave continues from it.
    t.autosave.rebase(doc("theirs"), 3, "t3");
    expect(t.last()).toMatchObject({ status: "saved", stopped: false });
    expect(t.draft.clear).toHaveBeenCalled();
    t.autosave.update(doc("theirs + mine"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.calls[1]).toMatchObject({ expected: 3 });
  });

  it("stops when the entry was deleted meanwhile", async () => {
    const t = setup();
    t.autosave.update(doc("mine"));
    await vi.advanceTimersByTimeAsync(1500);
    t.calls[0].reject(new ApiError("This entry was deleted", 404, { code: "deleted", deletedByName: "Lab" }));
    await settle();
    expect(t.last()).toMatchObject({ status: "deleted", stopped: true });
    expect(t.onDeleted).toHaveBeenCalledWith(expect.objectContaining({ deletedByName: "Lab" }), doc("mine"));
  });

  it("retries network and server errors with a growing delay", async () => {
    const t = setup();
    t.autosave.update(doc("a"));
    await vi.advanceTimersByTimeAsync(1500);
    t.calls[0].reject(new TypeError("Failed to fetch"));
    await settle();
    expect(t.last()).toMatchObject({ status: "retrying", stopped: false });
    t.autosave.update(doc("ab")); // typed while offline: sent by the retry
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].doc).toEqual(doc("ab"));
    t.calls[1].reject(new ApiError("Internal", 500));
    await settle();
    await vi.advanceTimersByTimeAsync(3999);
    expect(t.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls).toHaveLength(3);
    t.calls[2].reject(new ApiError("busy", 409, { code: "busy" }));
    await settle();
    expect(t.last().status).toBe("retrying");
  });

  it("stops when access is lost", async () => {
    const t = setup();
    t.autosave.update(doc("a"));
    await vi.advanceTimersByTimeAsync(1500);
    t.calls[0].reject(new ApiError("Device not found", 404));
    await settle();
    expect(t.last()).toMatchObject({ status: "error", stopped: true, error: "Not saved: Device not found" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toHaveLength(1);
  });

  it("doesn't send a document that fails validation, until it changes", async () => {
    const t = setup();
    const huge = doc("x".repeat(310 * 1024));
    t.autosave.update(huge);
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.calls).toHaveLength(0);
    expect(t.last()).toMatchObject({ status: "error", stopped: false });
    expect(t.last().error).toContain("too large");
    t.autosave.update(doc("smaller"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.calls).toHaveLength(1);
  });

  it("flush saves now and reports whether everything is saved", async () => {
    const t = setup();
    t.autosave.update(doc("a"));
    const flushed = t.autosave.flush();
    await settle();
    expect(t.calls).toHaveLength(1);
    t.calls[0].resolve(entry(2));
    expect(await flushed).toBe(true);

    t.autosave.update(doc("b"));
    const failing = t.autosave.flush();
    await settle();
    t.calls[1].reject(new TypeError("offline"));
    expect(await failing).toBe(false);
    expect(t.draft.write).toHaveBeenCalledWith(doc("b"), 2);
  });

  it("on close, keeps the draft and sends the unsaved changes once more", async () => {
    const t = setup();
    t.autosave.update(doc("closing"));
    t.autosave.dispose();
    expect(t.draft.write).toHaveBeenCalledWith(doc("closing"), 1);
    expect(t.calls).toHaveLength(1);
    const statesBefore = t.states.length;
    t.calls[0].resolve(entry(2));
    await settle();
    expect(t.draft.clear).toHaveBeenCalled();
    expect(t.states.length).toBe(statesBefore); // no updates to an unmounted view
  });

  it("on close during a save, sends the newer changes afterwards", async () => {
    const t = setup();
    t.autosave.update(doc("first"));
    await vi.advanceTimersByTimeAsync(1500);
    t.autosave.update(doc("second"));
    t.autosave.dispose();
    t.calls[0].resolve(entry(2));
    await settle();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]).toMatchObject({ doc: doc("second"), expected: 2 });
  });

  it("abandoning drops the changes and their draft, and sends nothing on close", async () => {
    const t = setup();
    t.autosave.update(doc("discard me"));
    t.autosave.abandon();
    expect(t.draft.clear).toHaveBeenCalled();
    t.draft.write.mockClear();
    t.autosave.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.calls).toHaveLength(0);
    expect(t.draft.write).not.toHaveBeenCalled();
    expect(t.autosave.hasUnsaved()).toBe(false);
  });

  it("a restored draft is saved against the version it was based on", async () => {
    const t = setup({ contentVersion: 5 });
    t.autosave.restore(doc("from draft"), 3);
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.calls[0]).toMatchObject({ doc: doc("from draft"), expected: 3 });
  });
});
