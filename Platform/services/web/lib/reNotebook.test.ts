import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  apiRequest: vi.fn(),
}));

import { ApiError, apiRequest } from "./api";
import {
  createEntry,
  deleteEntry,
  deleteSection,
  findEntry,
  getNotebook,
  isRetryableSaveError,
  moveEntry,
  moved,
  notebookRefusal,
  renameEntry,
  reorderEntries,
  reorderSections,
  saveEntryContent,
  withEntry,
  type Notebook,
  type NotebookEntry,
  type NotebookSection,
} from "./reNotebook";

const request = vi.mocked(apiRequest);
const D = "11111111-1111-4111-8111-000000000001";

function entry(id: string, sectionId: string, patch: Partial<NotebookEntry> = {}): NotebookEntry {
  return {
    entryId: id, sectionId, title: id, version: 1, contentVersion: 1, textLength: 0,
    createdBy: null, createdByName: null, createdAt: null, updatedBy: null, updatedByName: null, updatedAt: null,
    contentUpdatedBy: null, contentUpdatedByName: null, contentUpdatedAt: null, ...patch,
  };
}

function section(id: string, entries: NotebookEntry[], patch: Partial<NotebookSection> = {}): NotebookSection {
  return {
    sectionId: id, title: id, version: 1, orderVersion: entries.length, entries,
    createdBy: null, createdByName: null, createdAt: null, updatedBy: null, updatedByName: null, updatedAt: null, ...patch,
  };
}

const notebook: Notebook = {
  deviceId: D,
  orderVersion: 2,
  sections: [section("s1", [entry("e1", "s1"), entry("e2", "s1")]), section("s2", [entry("e3", "s2")])],
  limits: { sections: 50, entriesPerSection: 200, titleLength: 200, documentBytes: 307200 },
};

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({ notebook });
});

describe("API calls", () => {
  it("send the versions they were based on", async () => {
    await getNotebook(D);
    expect(request).toHaveBeenLastCalledWith("GET", `/devices/${D}/notebook`);
    await reorderSections(D, notebook, ["s2", "s1"]);
    expect(request).toHaveBeenLastCalledWith("PUT", `/devices/${D}/notebook/section-order`, {
      body: { sectionIds: ["s2", "s1"], expectedOrderVersion: 2 },
    });
    await reorderEntries(D, notebook.sections[0], ["e2", "e1"]);
    expect(request).toHaveBeenLastCalledWith("PUT", `/devices/${D}/notebook/sections/s1/entry-order`, {
      body: { entryIds: ["e2", "e1"], expectedOrderVersion: 2 },
    });
    await deleteSection(D, section("s9", [], { version: 4 }));
    expect(request).toHaveBeenLastCalledWith("DELETE", `/devices/${D}/notebook/sections/s9`, { query: { expectedVersion: 4 } });
    await createEntry(D, "s1", "Opening the device");
    expect(request).toHaveBeenLastCalledWith("POST", `/devices/${D}/notebook/sections/s1/entries`, {
      body: { title: "Opening the device" },
    });
    await renameEntry(D, entry("e1", "s1", { version: 3 }), "New");
    expect(request).toHaveBeenLastCalledWith("PATCH", `/devices/${D}/notebook/entries/e1`, {
      body: { title: "New", expectedVersion: 3 },
    });
    await moveEntry(D, entry("e1", "s1", { version: 3 }), "s2");
    expect(request).toHaveBeenLastCalledWith("POST", `/devices/${D}/notebook/entries/e1/move`, {
      body: { targetSectionId: "s2", expectedVersion: 3 },
    });
    await deleteEntry(D, entry("e1", "s1", { version: 3, contentVersion: 7 }));
    expect(request).toHaveBeenLastCalledWith("DELETE", `/devices/${D}/notebook/entries/e1`, {
      query: { expectedVersion: 3, expectedContentVersion: 7 },
    });
    request.mockResolvedValueOnce({ entry: entry("e1", "s1") });
    const doc = { type: "doc" as const, content: [{ type: "paragraph" }] };
    await saveEntryContent(D, "e1", doc, 7);
    expect(request).toHaveBeenLastCalledWith("PUT", `/devices/${D}/notebook/entries/e1/content`, {
      body: { doc, expectedContentVersion: 7 },
    });
  });
});

describe("refusals", () => {
  it("reads the current state from a refusal", () => {
    const refusal = notebookRefusal(new ApiError("changed", 409, { code: "conflict", entry: entry("e1", "s1") }));
    expect(refusal).toMatchObject({ code: "conflict", status: 409, entry: { entryId: "e1" } });
    expect(notebookRefusal(new ApiError("x", 400, { code: "weird" }))?.code).toBe("other");
    expect(notebookRefusal(new Error("x"))).toBeNull();
  });

  it("retries only what may succeed unchanged", () => {
    expect(isRetryableSaveError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableSaveError(new ApiError("x", 502))).toBe(true);
    expect(isRetryableSaveError(new ApiError("x", 409, { code: "busy" }))).toBe(true);
    expect(isRetryableSaveError(new ApiError("x", 409, { code: "conflict" }))).toBe(false);
    expect(isRetryableSaveError(new ApiError("x", 404, { code: "deleted" }))).toBe(false);
    expect(isRetryableSaveError(new ApiError("x", 400, { code: "invalid_document" }))).toBe(false);
    expect(isRetryableSaveError(new ApiError("x", 403))).toBe(false);
  });
});

describe("structure helpers", () => {
  it("finds and replaces entries", () => {
    expect(findEntry(notebook, "e3")?.sectionId).toBe("s2");
    expect(findEntry(notebook, "missing")).toBeUndefined();
    const updated = withEntry(notebook, entry("e2", "s1", { contentVersion: 9 }));
    expect(findEntry(updated, "e2")?.contentVersion).toBe(9);
    expect(findEntry(notebook, "e2")?.contentVersion).toBe(1);
  });

  it("moves an item one place, or not at all at an end", () => {
    expect(moved(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moved(["a", "b"], 0, -1)).toBeNull();
    expect(moved(["a", "b"], 1, 1)).toBeNull();
  });
});
