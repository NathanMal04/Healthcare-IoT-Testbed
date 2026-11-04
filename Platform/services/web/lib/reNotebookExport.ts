// Exporting a device's whole RE Notebook (to print, or save as PDF with the
// browser's print dialog). The notebook is read fresh, so the export has the
// sections and entries in their saved order, then every entry's document;
// the page renders them with the notebook's read-only view and waits for the
// images before printing.

import { getEntry, getNotebook, notebookErrorMessage, type EntryWithDoc, type Notebook, type NotebookEntry, type NotebookSection } from "./reNotebook";
import { docImageIds, type NotebookDoc, type NotebookNode } from "./reNotebookDoc";

export interface ExportedEntry {
  entry: NotebookEntry;
  /** Null when the entry couldn't be read (deleted meanwhile, an error). */
  doc: NotebookDoc | null;
  error: string | null;
}

export interface ExportedSection {
  section: NotebookSection;
  entries: ExportedEntry[];
}

export interface NotebookExport {
  notebook: Notebook;
  sections: ExportedSection[];
  entryCount: number;
  /** Entries that couldn't be read. */
  failedCount: number;
  /** Every image the documents reference, each once (for one batch of view URLs). */
  imageIds: string[];
  /** How many images the documents show, repeats included (what the page waits for). */
  imageCount: number;
}

export interface ExportOptions {
  /** Entries read at the same time. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** For tests. */
  fetchNotebook?: (deviceId: string) => Promise<Notebook>;
  fetchEntry?: (deviceId: string, entryId: string) => Promise<EntryWithDoc>;
}

function aborted(): Error {
  const err = new Error("Export cancelled");
  err.name = "AbortError";
  return err;
}

/**
 * The notebook with every entry's document, in notebook order. An entry that
 * can't be read doesn't stop the export: it is listed with its error, so the
 * page can say what's missing.
 */
export async function loadNotebookExport(deviceId: string, options: ExportOptions = {}): Promise<NotebookExport> {
  const { concurrency = 4, onProgress, signal, fetchNotebook = getNotebook, fetchEntry = getEntry } = options;
  if (signal?.aborted) throw aborted();
  const notebook = await fetchNotebook(deviceId);
  if (signal?.aborted) throw aborted();

  const entries = notebook.sections.flatMap((section) => section.entries);
  const results: ExportedEntry[] = new Array(entries.length);
  let next = 0;
  let done = 0;
  onProgress?.(0, entries.length);

  async function worker() {
    while (next < entries.length) {
      if (signal?.aborted) throw aborted();
      const index = next++;
      const entry = entries[index];
      try {
        const loaded = await fetchEntry(deviceId, entry.entryId);
        results[index] = { entry: { ...entry, ...loaded.entry }, doc: loaded.doc, error: null };
      } catch (err) {
        results[index] = { entry, doc: null, error: notebookErrorMessage(err, "Couldn't read the entry") };
      }
      done += 1;
      onProgress?.(done, entries.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, worker));
  if (signal?.aborted) throw aborted();

  let cursor = 0;
  const sections = notebook.sections.map((section) => ({
    section,
    entries: section.entries.map(() => results[cursor++]),
  }));
  const docs = results.flatMap((r) => (r.doc ? [r.doc] : []));
  const imageIds = [...new Set(docs.flatMap((doc) => docImageIds(doc)))];
  return {
    notebook,
    sections,
    entryCount: entries.length,
    failedCount: results.filter((r) => !r.doc).length,
    imageIds,
    imageCount: docs.reduce((n, doc) => n + countImages(doc), 0),
  };
}

/** How many image nodes a document has (an image used twice counts twice). */
export function countImages(node: NotebookNode): number {
  if (node.type === "image") return 1;
  return (node.content ?? []).reduce((n, child) => n + countImages(child), 0);
}

export interface RenderWait {
  /** Images shown. */
  loaded: number;
  /** Images that couldn't be shown (unavailable, broken, or still loading at the timeout). */
  failed: number;
  timedOut: boolean;
}

/**
 * Resolves once `container` shows `documents` rendered documents and
 * `images` images, none of them still loading: each image is then either
 * shown or a placeholder (NotebookImage.tsx marks them with
 * data-notebook-image-state). Gives up after `timeoutMs`, counting what is
 * still loading as failed, so a slow or missing image never blocks printing.
 */
export function waitForRender(
  container: HTMLElement,
  {
    documents,
    images,
    timeoutMs = 30_000,
    intervalMs = 100,
    signal,
  }: { documents: number; images: number; timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }
): Promise<RenderWait> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (signal?.aborted) {
        reject(aborted());
        return;
      }
      const states = [...container.querySelectorAll<HTMLElement>("[data-notebook-image-state]")].map(
        (el) => el.dataset.notebookImageState
      );
      const loaded = states.filter((s) => s === "ready").length;
      const errors = states.filter((s) => s === "error").length;
      const rendered = container.querySelectorAll(".re-notebook-doc").length >= documents;
      if (rendered && states.length >= images && loaded + errors >= images) {
        resolve({ loaded, failed: errors, timedOut: false });
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve({ loaded, failed: Math.max(0, images - loaded), timedOut: true });
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}
