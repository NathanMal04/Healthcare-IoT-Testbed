// The RE Notebook API (re-notebook-api): one reverse-engineering notebook per
// device, made of ordered sections of research entries. Access follows the
// device: its owner for a personal device, every member of its workspace for
// a workspace device. The backend enforces that and every version check.

import { ApiError, apiRequest } from "./api";
import type { NotebookDoc } from "./reNotebookDoc";

export interface Authorship {
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
}

/** An entry as the structure lists it: everything but its document. */
export interface NotebookEntry extends Authorship {
  entryId: string;
  sectionId: string;
  title: string;
  /** Title and placement (rename, move, delete); separate from the content. */
  version: number;
  /** The document's version; autosave sends the one it started from. */
  contentVersion: number;
  textLength: number;
  contentUpdatedBy: string | null;
  contentUpdatedByName: string | null;
  contentUpdatedAt: string | null;
}

export interface NotebookSection extends Authorship {
  sectionId: string;
  title: string;
  version: number;
  /** Version of the order of its entries. */
  orderVersion: number;
  entries: NotebookEntry[];
}

export interface Notebook {
  deviceId: string;
  /** Version of the order of the sections; 0 for a notebook without any. */
  orderVersion: number;
  sections: NotebookSection[];
  limits: { sections: number; entriesPerSection: number; titleLength: number; documentBytes: number };
}

export interface EntryWithDoc {
  entry: NotebookEntry;
  doc: NotebookDoc;
}

const base = (deviceId: string) => `/devices/${encodeURIComponent(deviceId)}/notebook`;
const section = (deviceId: string, sectionId: string) => `${base(deviceId)}/sections/${encodeURIComponent(sectionId)}`;
const entry = (deviceId: string, entryId: string) => `${base(deviceId)}/entries/${encodeURIComponent(entryId)}`;

export async function getNotebook(deviceId: string): Promise<Notebook> {
  return (await apiRequest<{ notebook: Notebook }>("GET", base(deviceId))).notebook;
}

export async function createSection(deviceId: string, title: string): Promise<{ sectionId: string; notebook: Notebook }> {
  return apiRequest("POST", `${base(deviceId)}/sections`, { body: { title } });
}

export async function renameSection(deviceId: string, s: NotebookSection, title: string): Promise<Notebook> {
  return (
    await apiRequest<{ notebook: Notebook }>("PATCH", section(deviceId, s.sectionId), {
      body: { title, expectedVersion: s.version },
    })
  ).notebook;
}

/** Only an empty section can be deleted. */
export async function deleteSection(deviceId: string, s: NotebookSection): Promise<Notebook> {
  return (
    await apiRequest<{ notebook: Notebook }>("DELETE", section(deviceId, s.sectionId), {
      query: { expectedVersion: s.version },
    })
  ).notebook;
}

export async function reorderSections(deviceId: string, notebook: Notebook, sectionIds: string[]): Promise<Notebook> {
  return (
    await apiRequest<{ notebook: Notebook }>("PUT", `${base(deviceId)}/section-order`, {
      body: { sectionIds, expectedOrderVersion: notebook.orderVersion },
    })
  ).notebook;
}

export async function createEntry(
  deviceId: string,
  sectionId: string,
  title: string
): Promise<{ entryId: string; notebook: Notebook }> {
  return apiRequest("POST", `${section(deviceId, sectionId)}/entries`, { body: { title } });
}

export async function reorderEntries(deviceId: string, s: NotebookSection, entryIds: string[]): Promise<Notebook> {
  return (
    await apiRequest<{ notebook: Notebook }>("PUT", `${section(deviceId, s.sectionId)}/entry-order`, {
      body: { entryIds, expectedOrderVersion: s.orderVersion },
    })
  ).notebook;
}

export async function getEntry(deviceId: string, entryId: string): Promise<EntryWithDoc> {
  return apiRequest("GET", entry(deviceId, entryId));
}

export async function renameEntry(
  deviceId: string,
  e: NotebookEntry,
  title: string
): Promise<{ entry: NotebookEntry; notebook: Notebook }> {
  return apiRequest("PATCH", entry(deviceId, e.entryId), { body: { title, expectedVersion: e.version } });
}

/** Autosave: refused with a conflict if the content moved past `expectedContentVersion`. */
export async function saveEntryContent(
  deviceId: string,
  entryId: string,
  doc: NotebookDoc,
  expectedContentVersion: number
): Promise<NotebookEntry> {
  return (
    await apiRequest<{ entry: NotebookEntry }>("PUT", `${entry(deviceId, entryId)}/content`, {
      body: { doc, expectedContentVersion },
    })
  ).entry;
}

export async function moveEntry(
  deviceId: string,
  e: NotebookEntry,
  targetSectionId: string,
  position?: number
): Promise<{ entry: NotebookEntry; notebook: Notebook }> {
  return apiRequest("POST", `${entry(deviceId, e.entryId)}/move`, {
    body: { targetSectionId, expectedVersion: e.version, ...(position !== undefined ? { position } : {}) },
  });
}

/** Soft delete: the entry leaves the notebook; its content is kept in the database. */
export async function deleteEntry(deviceId: string, e: NotebookEntry): Promise<Notebook> {
  return (
    await apiRequest<{ notebook: Notebook }>("DELETE", entry(deviceId, e.entryId), {
      query: { expectedVersion: e.version, expectedContentVersion: e.contentVersion },
    })
  ).notebook;
}

// --- Errors ----------------------------------------------------------------------

/** What a refused request says about the current state, from its 409/404 body. */
export interface NotebookRefusal {
  code: "conflict" | "deleted" | "stale_order" | "busy" | "limit" | "not_empty" | "invalid_document" | "other";
  message: string;
  status: number;
  /** The current notebook, sent back with a stale reorder. */
  notebook?: Notebook;
  /** The entry as it is now (conflicts). */
  entry?: NotebookEntry;
  /** The document as it is now (content conflicts). */
  doc?: NotebookDoc;
  deletedByName?: string | null;
  deletedAt?: string | null;
}

const CODES = new Set(["conflict", "deleted", "stale_order", "busy", "limit", "not_empty", "invalid_document"]);

export function notebookRefusal(err: unknown): NotebookRefusal | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details ?? {};
  const code = typeof details.code === "string" && CODES.has(details.code) ? details.code : "other";
  return {
    code: code as NotebookRefusal["code"],
    message: err.message,
    status: err.status,
    notebook: details.notebook as Notebook | undefined,
    entry: details.entry as NotebookEntry | undefined,
    doc: details.doc as NotebookDoc | undefined,
    deletedByName: (details.deletedByName as string | null | undefined) ?? null,
    deletedAt: (details.deletedAt as string | null | undefined) ?? null,
  };
}

/**
 * Whether a failed save may be retried as it is: a network failure, a server
 * error or a momentary transaction clash. A conflict, a deleted entry, an
 * invalid document or lost access needs the user instead.
 */
export function isRetryableSaveError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true; // network / no response
  if (err.status >= 500 || err.status === 429) return true;
  return err.status === 409 && notebookRefusal(err)?.code === "busy";
}

export function notebookErrorMessage(err: unknown, fallback = "Request failed"): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

// --- Structure helpers -------------------------------------------------------------

export function findEntry(notebook: Notebook | null, entryId: string | null | undefined): NotebookEntry | undefined {
  if (!notebook || !entryId) return undefined;
  for (const s of notebook.sections) {
    const found = s.entries.find((e) => e.entryId === entryId);
    if (found) return found;
  }
  return undefined;
}

/** The notebook with one entry's metadata replaced (e.g. after a save). */
export function withEntry(notebook: Notebook, updated: NotebookEntry): Notebook {
  return {
    ...notebook,
    sections: notebook.sections.map((s) =>
      s.sectionId !== updated.sectionId
        ? s
        : { ...s, entries: s.entries.map((e) => (e.entryId === updated.entryId ? updated : e)) }
    ),
  };
}

/** `ids` with the item at `index` moved one place up (-1) or down (+1); null at an end. */
export function moved<T>(ids: T[], index: number, delta: -1 | 1): T[] | null {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return null;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
