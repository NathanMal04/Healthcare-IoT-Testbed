"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createEntry,
  createSection,
  deleteEntry,
  deleteSection,
  getNotebook,
  moveEntry,
  moved,
  notebookErrorMessage,
  notebookRefusal,
  renameEntry,
  renameSection,
  reorderEntries,
  reorderSections,
  withEntry,
  type Notebook,
  type NotebookEntry,
  type NotebookSection,
} from "@/lib/reNotebook";

export interface NotebookControls {
  notebook: Notebook | null;
  loadError: string | null;
  /** A structural change is being saved. */
  busy: boolean;
  /** The last change that failed, explained. */
  error: string | null;
  dismissError: () => void;
  reload: () => Promise<void>;
  addSection: (title: string) => Promise<string | null>;
  renameSection: (section: NotebookSection, title: string) => Promise<boolean>;
  deleteSection: (section: NotebookSection) => Promise<boolean>;
  moveSection: (index: number, delta: -1 | 1) => Promise<boolean>;
  addEntry: (sectionId: string, title: string) => Promise<string | null>;
  renameEntry: (entry: NotebookEntry, title: string) => Promise<boolean>;
  moveEntryWithin: (section: NotebookSection, index: number, delta: -1 | 1) => Promise<boolean>;
  moveEntryTo: (entry: NotebookEntry, targetSectionId: string) => Promise<boolean>;
  deleteEntry: (entry: NotebookEntry) => Promise<boolean>;
  /** An entry's metadata changed elsewhere (e.g. its content was saved). */
  applyEntry: (entry: NotebookEntry) => void;
  /** Replaces the structure with one a request returned. */
  setNotebook: (notebook: Notebook) => void;
}

/**
 * The notebook's structure (sections and entries, without documents) and its
 * changes. Every change returns the notebook as the server now has it, which
 * replaces the local copy. A change refused because someone else changed the
 * notebook first shows what is there now and says so; nothing is retried
 * blindly.
 */
export function useNotebook(deviceId: string): NotebookControls {
  const [notebook, setNotebookState] = useState<Notebook | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setNotebook = useCallback((next: Notebook) => {
    if (mountedRef.current) setNotebookState(next);
  }, []);

  const reload = useCallback(async () => {
    try {
      const next = await getNotebook(deviceId);
      if (!mountedRef.current) return;
      setNotebookState(next);
      setLoadError(null);
    } catch (err) {
      if (mountedRef.current) setLoadError(notebookErrorMessage(err, "Couldn't load the notebook"));
    }
  }, [deviceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Runs one change; on refusal, shows the current notebook and explains. */
  const change = useCallback(
    async <T>(action: () => Promise<T>, apply: (result: T) => Notebook, what: string): Promise<T | null> => {
      if (busyRef.current) return null;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        setNotebook(apply(result));
        return result;
      } catch (err) {
        const refusal = notebookRefusal(err);
        if (refusal?.notebook) setNotebook(refusal.notebook);
        else if (refusal && ["conflict", "stale_order", "busy", "deleted"].includes(refusal.code)) await reload();
        if (mountedRef.current) setError(explain(what, refusal?.code, notebookErrorMessage(err)));
        return null;
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [reload, setNotebook]
  );

  const current = useRef<Notebook | null>(null);
  current.current = notebook;

  return {
    notebook,
    loadError,
    busy,
    error,
    dismissError: useCallback(() => setError(null), []),
    reload,
    setNotebook,
    addSection: useCallback(
      async (title) => (await change(() => createSection(deviceId, title), (r) => r.notebook, "add the section"))?.sectionId ?? null,
      [change, deviceId]
    ),
    renameSection: useCallback(
      async (section, title) => !!(await change(() => renameSection(deviceId, section, title), (n) => n, "rename the section")),
      [change, deviceId]
    ),
    deleteSection: useCallback(
      async (section) => !!(await change(() => deleteSection(deviceId, section), (n) => n, "delete the section")),
      [change, deviceId]
    ),
    moveSection: useCallback(
      async (index, delta) => {
        const nb = current.current;
        const ids = nb && moved(nb.sections.map((s) => s.sectionId), index, delta);
        if (!nb || !ids) return false;
        return !!(await change(() => reorderSections(deviceId, nb, ids), (n) => n, "move the section"));
      },
      [change, deviceId]
    ),
    addEntry: useCallback(
      async (sectionId, title) =>
        (await change(() => createEntry(deviceId, sectionId, title), (r) => r.notebook, "add the entry"))?.entryId ?? null,
      [change, deviceId]
    ),
    renameEntry: useCallback(
      async (entry, title) => !!(await change(() => renameEntry(deviceId, entry, title), (r) => r.notebook, "rename the entry")),
      [change, deviceId]
    ),
    moveEntryWithin: useCallback(
      async (section, index, delta) => {
        const ids = moved(section.entries.map((e) => e.entryId), index, delta);
        if (!ids) return false;
        return !!(await change(() => reorderEntries(deviceId, section, ids), (n) => n, "move the entry"));
      },
      [change, deviceId]
    ),
    moveEntryTo: useCallback(
      async (entry, targetSectionId) =>
        !!(await change(() => moveEntry(deviceId, entry, targetSectionId), (r) => r.notebook, "move the entry")),
      [change, deviceId]
    ),
    deleteEntry: useCallback(
      async (entry) => !!(await change(() => deleteEntry(deviceId, entry), (n) => n, "delete the entry")),
      [change, deviceId]
    ),
    applyEntry: useCallback((entry: NotebookEntry) => {
      if (mountedRef.current) setNotebookState((nb) => (nb ? withEntry(nb, entry) : nb));
    }, []),
  };
}

function explain(what: string, code: string | undefined, message: string): string {
  switch (code) {
    case "conflict":
    case "stale_order":
      return `Couldn't ${what}: someone else changed the notebook at the same time. It now shows the latest version; try again if it's still needed.`;
    case "busy":
      return `Couldn't ${what}: the notebook was being changed at the same time. Try again.`;
    case "deleted":
      return `Couldn't ${what}: that entry has been deleted.`;
    default:
      return `Couldn't ${what}: ${message}`;
  }
}
