// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDraft,
  clearUserDrafts,
  discardNotebookWork,
  flushNotebookWork,
  hasUnsavedNotebookWork,
  readDraft,
  registerPendingWork,
  writeDraft,
} from "./reNotebookDrafts";
import type { NotebookDoc } from "./reNotebookDoc";

const doc = (text: string): NotebookDoc => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const A = { userId: "user-a", deviceId: "dev-1", entryId: "entry-1" };

beforeEach(() => localStorage.clear());

describe("drafts", () => {
  it("are kept per user, device and entry", () => {
    expect(writeDraft(A, doc("a"), 3)).toBe(true);
    expect(readDraft(A)).toMatchObject({ doc: doc("a"), baseContentVersion: 3 });
    expect(readDraft({ ...A, userId: "user-b" })).toBeNull();
    expect(readDraft({ ...A, deviceId: "dev-2" })).toBeNull();
    expect(readDraft({ ...A, entryId: "entry-2" })).toBeNull();
    clearDraft(A);
    expect(readDraft(A)).toBeNull();
  });

  it("are all removed for the user signing out, and only theirs", () => {
    writeDraft(A, doc("a"), 1);
    writeDraft({ ...A, entryId: "entry-2" }, doc("b"), 1);
    writeDraft({ ...A, userId: "user-b" }, doc("c"), 1);
    localStorage.setItem("unrelated", "kept");
    clearUserDrafts("user-a");
    expect(readDraft(A)).toBeNull();
    expect(readDraft({ ...A, entryId: "entry-2" })).toBeNull();
    expect(readDraft({ ...A, userId: "user-b" })).not.toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("kept");
  });

  it("hold only the document and its version", () => {
    writeDraft(A, doc("a"), 1);
    const stored = JSON.parse(localStorage.getItem(Object.keys(localStorage)[0])!);
    expect(Object.keys(stored).sort()).toEqual(["baseContentVersion", "doc", "savedAt"]);
  });

  it("ignore anything that isn't a valid draft", () => {
    writeDraft(A, doc("a"), 1);
    const key = Object.keys(localStorage)[0];
    localStorage.setItem(key, "{not json");
    expect(readDraft(A)).toBeNull();
    localStorage.setItem(key, JSON.stringify({ doc: "<p>html</p>", baseContentVersion: 1, savedAt: "x" }));
    expect(readDraft(A)).toBeNull();
  });
});

describe("pending work", () => {
  it("is saved before sign-out, which learns whether anything is left", async () => {
    let unsaved = true;
    const unregister = registerPendingWork({
      discard: () => undefined,
      hasUnsaved: () => unsaved,
      flush: async () => {
        unsaved = false;
        return true;
      },
    });
    expect(hasUnsavedNotebookWork()).toBe(true);
    expect(await flushNotebookWork()).toBe(true);
    expect(hasUnsavedNotebookWork()).toBe(false);
    let discarded = false;
    const stuck = registerPendingWork({
      hasUnsaved: () => !discarded,
      flush: async () => false,
      discard: () => {
        discarded = true;
      },
    });
    expect(await flushNotebookWork()).toBe(false);
    discardNotebookWork();
    expect(hasUnsavedNotebookWork()).toBe(false);
    stuck();
    unregister();
    expect(hasUnsavedNotebookWork()).toBe(false);
  });
});
