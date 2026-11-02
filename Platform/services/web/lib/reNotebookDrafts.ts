// Local safety net for RE Notebook edits.
//
// Drafts: while an entry has changes the server hasn't confirmed, the latest
// version is kept in this browser's localStorage, keyed by user, device and
// entry. A confirmed save removes it; so does signing out. If the tab closes,
// crashes or loses its connection first, the draft is offered the next time
// the entry is opened. Only the document and the version it was based on are
// stored: never credentials or tokens.
//
// Pending work: open editors register here, so signing out can first save
// what's unsaved (and warn when it can't).

import { validateDoc, type NotebookDoc } from "./reNotebookDoc";

const PREFIX = "vzoniq.reNotebook.draft.v1.";

export interface EntryDraft {
  doc: NotebookDoc;
  /** The contentVersion the edits started from. */
  baseContentVersion: number;
  /** When the draft was written (this browser's clock). */
  savedAt: string;
}

export interface DraftScope {
  userId: string;
  deviceId: string;
  entryId: string;
}

function draftKey({ userId, deviceId, entryId }: DraftScope): string {
  return `${PREFIX}${userId}.${deviceId}.${entryId}`;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // blocked storage
  }
}

export function readDraft(scope: DraftScope): EntryDraft | null {
  try {
    const raw = storage()?.getItem(draftKey(scope));
    if (!raw) return null;
    const draft = JSON.parse(raw) as EntryDraft;
    if (
      !draft ||
      typeof draft.baseContentVersion !== "number" ||
      typeof draft.savedAt !== "string" ||
      !validateDoc(draft.doc).ok
    ) {
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

/** Returns false when the draft couldn't be kept (storage full or blocked). */
export function writeDraft(scope: DraftScope, doc: NotebookDoc, baseContentVersion: number): boolean {
  const draft: EntryDraft = { doc, baseContentVersion, savedAt: new Date().toISOString() };
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(draftKey(scope), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(scope: DraftScope): void {
  try {
    storage()?.removeItem(draftKey(scope));
  } catch {
    // nothing to clear
  }
}

/** Removes every notebook draft of the user (on sign-out). */
export function clearUserDrafts(userId: string): void {
  try {
    const store = storage();
    if (!store) return;
    const prefix = `${PREFIX}${userId}.`;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    keys.forEach((key) => store.removeItem(key));
  } catch {
    // nothing to clear
  }
}

// --- Pending work -------------------------------------------------------------------

export interface PendingWork {
  /** Whether there are changes the server hasn't confirmed. */
  hasUnsaved(): boolean;
  /** Saves now; resolves true once nothing is left unsaved. */
  flush(): Promise<boolean>;
  /** Drops what's unsaved, draft included (signing out anyway). */
  discard(): void;
}

const pending = new Set<PendingWork>();

export function registerPendingWork(work: PendingWork): () => void {
  pending.add(work);
  return () => {
    pending.delete(work);
  };
}

export function hasUnsavedNotebookWork(): boolean {
  return [...pending].some((work) => work.hasUnsaved());
}

/** Drops every open editor's unsaved changes and drafts (before signing out anyway). */
export function discardNotebookWork(): void {
  pending.forEach((work) => work.discard());
}

/** Saves every open editor's changes; true when all of them are saved. */
export async function flushNotebookWork(): Promise<boolean> {
  const results = await Promise.all([...pending].map((work) => work.flush().catch(() => false)));
  return results.every(Boolean);
}
