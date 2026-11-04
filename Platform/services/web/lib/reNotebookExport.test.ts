// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { EntryWithDoc, Notebook, NotebookEntry, NotebookSection } from "./reNotebook";
import type { NotebookDoc, NotebookNode } from "./reNotebookDoc";
import { countImages, loadNotebookExport, waitForRender } from "./reNotebookExport";

const A = "0192d000-0000-7000-8000-000000000001";
const B = "0192d000-0000-7000-8000-000000000002";

function entry(id: string, sectionId: string): NotebookEntry {
  return {
    entryId: id, sectionId, title: `Entry ${id}`, version: 1, contentVersion: 1, textLength: 0,
    createdBy: null, createdByName: null, createdAt: null, updatedBy: null, updatedByName: null, updatedAt: null,
    contentUpdatedBy: null, contentUpdatedByName: null, contentUpdatedAt: null,
  } as NotebookEntry;
}

function section(id: string, entryIds: string[]): NotebookSection {
  return {
    sectionId: id, title: `Section ${id}`, version: 1, orderVersion: 1, entries: entryIds.map((e) => entry(e, id)),
    createdBy: null, createdByName: null, createdAt: null, updatedBy: null, updatedByName: null, updatedAt: null,
  } as NotebookSection;
}

const notebook = (sections: NotebookSection[]): Notebook =>
  ({ deviceId: "d", orderVersion: 1, sections, limits: { sections: 50, entriesPerSection: 200, titleLength: 200, documentBytes: 1 } }) as Notebook;

const image = (artifactId: string): NotebookNode => ({ type: "image", attrs: { artifactId } });
const doc = (...content: NotebookNode[]): NotebookDoc => ({ type: "doc", content });
const text = (t: string): NotebookNode => ({ type: "paragraph", content: [{ type: "text", text: t }] });

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("loadNotebookExport", () => {
  it("keeps the notebook's order however the entries arrive, reading a few at a time", async () => {
    const nb = notebook([section("s1", ["e1", "e2", "e3"]), section("s2", []), section("s3", ["e4", "e5"])]);
    const docs: Record<string, NotebookDoc> = {
      e1: doc(text("one"), image(A)),
      e2: doc(text("two")),
      e3: doc(image(B), image(A)),
      e4: doc(text("four")),
      e5: doc(image(A)),
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const progress: [number, number][] = [];
    const result = await loadNotebookExport("d", {
      concurrency: 2,
      onProgress: (done, total) => progress.push([done, total]),
      fetchNotebook: async () => nb,
      fetchEntry: async (_d, id) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Earlier entries take longer, so they finish out of order.
        await tick(id === "e1" ? 30 : 5);
        inFlight--;
        return { entry: { ...entry(id, ""), sectionId: nb.sections.find((s) => s.entries.some((e) => e.entryId === id))!.sectionId, title: `Saved ${id}` }, doc: docs[id], schemaVersion: 1 } as EntryWithDoc;
      },
    });

    expect(maxInFlight).toBe(2);
    expect(result.sections.map((s) => [s.section.sectionId, s.entries.map((e) => e.entry.entryId)])).toEqual([
      ["s1", ["e1", "e2", "e3"]],
      ["s2", []],
      ["s3", ["e4", "e5"]],
    ]);
    expect(result.sections[0].entries[0]).toMatchObject({ doc: docs.e1, error: null, entry: { title: "Saved e1" } });
    expect(result.entryCount).toBe(5);
    expect(result.failedCount).toBe(0);
    expect(result.imageIds).toEqual([A, B]);
    expect(result.imageCount).toBe(4);
    expect(progress[0]).toEqual([0, 5]);
    expect(progress[progress.length - 1]).toEqual([5, 5]);
  });

  it("lists an entry it can't read with its error, and reads the rest", async () => {
    const result = await loadNotebookExport("d", {
      fetchNotebook: async () => notebook([section("s1", ["e1", "e2"])]),
      fetchEntry: async (_d, id) => {
        if (id === "e1") throw new Error("This entry was deleted");
        return { entry: entry(id, "s1"), doc: doc(text("ok")), schemaVersion: 1 };
      },
    });
    expect(result.failedCount).toBe(1);
    expect(result.sections[0].entries[0]).toMatchObject({ doc: null, error: "This entry was deleted" });
    expect(result.sections[0].entries[1]).toMatchObject({ doc: doc(text("ok")), error: null });
  });

  it("handles a notebook without entries", async () => {
    const result = await loadNotebookExport("d", { fetchNotebook: async () => notebook([section("s1", [])]), fetchEntry: async () => { throw new Error("unused"); } });
    expect(result).toMatchObject({ entryCount: 0, failedCount: 0, imageIds: [], imageCount: 0 });
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    const reads: string[] = [];
    const pending = loadNotebookExport("d", {
      concurrency: 1,
      signal: controller.signal,
      fetchNotebook: async () => notebook([section("s1", ["e1", "e2", "e3"])]),
      fetchEntry: async (_d, id) => {
        reads.push(id);
        controller.abort();
        return { entry: entry(id, "s1"), doc: doc(text("x")), schemaVersion: 1 };
      },
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toEqual(["e1"]);
  });

  it("counts every image node", () => {
    const list: NotebookNode = { type: "bulletList", content: [{ type: "listItem", content: [text("x"), image(A)] }] };
    expect(countImages(doc(image(A), list, image(B)))).toBe(3);
  });
});

describe("waitForRender", () => {
  function container(docs: number, states: string[]) {
    const root = document.createElement("div");
    for (let i = 0; i < docs; i++) root.appendChild(Object.assign(document.createElement("div"), { className: "re-notebook-doc" }));
    const images = states.map((state) => {
      const el = document.createElement("span");
      el.dataset.notebookImageState = state;
      root.appendChild(el);
      return el;
    });
    return { root, images };
  }

  it("waits for every document and image to be shown or to fail", async () => {
    const { root, images } = container(1, ["loading", "loading"]);
    let settled = false;
    const wait = waitForRender(root, { documents: 2, images: 3, intervalMs: 5 }).then((r) => {
      settled = true;
      return r;
    });
    await tick(20);
    expect(settled).toBe(false);
    root.appendChild(Object.assign(document.createElement("div"), { className: "re-notebook-doc" }));
    images[0].dataset.notebookImageState = "ready";
    images[1].dataset.notebookImageState = "error";
    await tick(20);
    expect(settled).toBe(false); // the third image hasn't rendered yet
    const third = document.createElement("span");
    third.dataset.notebookImageState = "ready";
    root.appendChild(third);
    expect(await wait).toEqual({ loaded: 2, failed: 1, timedOut: false });
  });

  it("gives up after the timeout, counting what is still loading as failed", async () => {
    const { root } = container(1, ["ready", "loading", "loading"]);
    expect(await waitForRender(root, { documents: 1, images: 3, intervalMs: 5, timeoutMs: 30 })).toEqual({
      loaded: 1,
      failed: 2,
      timedOut: true,
    });
  });

  it("resolves at once for a notebook without images", async () => {
    const { root } = container(2, []);
    expect(await waitForRender(root, { documents: 2, images: 0 })).toEqual({ loaded: 0, failed: 0, timedOut: false });
  });
});
