"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Copy, History, Trash2 } from "lucide-react";
import {
  createEntry,
  getEntry,
  notebookErrorMessage,
  notebookRefusal,
  saveEntryContent,
  type NotebookEntry,
  type NotebookRefusal,
  type NotebookSection,
} from "@/lib/reNotebook";
import { docText, normalizeDoc, sameDoc, type NotebookDoc, type NotebookNode } from "@/lib/reNotebookDoc";
import { notebookExtensions } from "@/lib/reNotebookEditor";
import { EntryAutosave, type AutosaveState } from "@/lib/reNotebookAutosave";
import { clearDraft, readDraft, registerPendingWork, writeDraft, type DraftScope, type EntryDraft } from "@/lib/reNotebookDrafts";
import { useScopeLock } from "@/context/WorkspaceContext";
import { Alert, Button, ErrorState, LoadingState, formatDate } from "@/app/components/ui";
import ConflictDialog from "./ConflictDialog";
import EditorToolbar from "./EditorToolbar";
import SaveStatus from "./SaveStatus";

/** What the notebook asks of the open editor before switching away from it. */
export interface EditorHandle {
  hasUnsaved(): boolean;
  /** Saves now; resolves true once nothing is left unsaved. */
  flush(): Promise<boolean>;
  /** The content version the editor last saved or loaded. */
  contentVersion(): number;
  /** Drops the unsaved changes and their draft. */
  discard(): void;
}

interface EditorProps {
  deviceId: string;
  userId: string;
  entry: NotebookEntry;
  sections: NotebookSection[];
  onHandle: (handle: EditorHandle | null) => void;
  /** The entry's metadata after a save (new contentVersion, editor, time). */
  onSaved: (entry: NotebookEntry) => void;
  /** Entries were added or the entry is gone: reload the structure. */
  onStructureChanged: () => void;
  /** Open another entry (e.g. the copy of a recovered version). */
  onOpenEntry: (entryId: string | null) => void;
  /** Actions shown in the entry's header (e.g. its menu). */
  headerActions?: React.ReactNode;
  /**
   * The save state, for a page that shows it elsewhere (its top bar); null
   * once the editor closes. Without it, the header shows the state.
   */
  onSaveState?: (save: SaveStateReport | null) => void;
}

export interface SaveStateReport {
  state: AutosaveState;
  retry: () => void;
}

type Loaded = { kind: "loaded"; entry: NotebookEntry; doc: NotebookDoc; draft: EntryDraft | null };
type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "deleted"; refusal: NotebookRefusal; draft: EntryDraft | null }
  | Loaded;

/**
 * One entry, open for editing, with autosave. Loads the entry's document,
 * offers any unsaved local draft of it, and handles the cases where a save
 * can't go through: someone else saved first (conflict dialog), the entry was
 * deleted meanwhile, or the server can't be reached (retried; the draft keeps
 * the changes).
 */
export default function EntryEditor(props: EditorProps) {
  const { deviceId, userId, entry } = props;
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const scope = useMemo<DraftScope>(() => ({ userId, deviceId, entryId: entry.entryId }), [userId, deviceId, entry.entryId]);

  useEffect(() => {
    let active = true;
    setLoad({ kind: "loading" });
    getEntry(deviceId, entry.entryId).then(
      (result) => {
        if (!active) return;
        let draft = readDraft(scope);
        if (draft && sameDoc(normalizeDoc(draft.doc), normalizeDoc(result.doc))) {
          clearDraft(scope); // already saved
          draft = null;
        }
        setLoad({ kind: "loaded", entry: result.entry, doc: result.doc, draft });
      },
      (err) => {
        if (!active) return;
        const refusal = notebookRefusal(err);
        if (refusal?.code === "deleted") setLoad({ kind: "deleted", refusal, draft: readDraft(scope) });
        else setLoad({ kind: "error", message: notebookErrorMessage(err, "Couldn't open the entry") });
      }
    );
    return () => {
      active = false;
    };
    // The entry's own metadata changes with every save; only its id reloads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, entry.entryId, scope]);

  if (load.kind === "loading") return <LoadingState label="Opening entry…" />;
  if (load.kind === "error") return <ErrorState title="Couldn't open the entry" message={load.message} />;
  if (load.kind === "deleted") {
    return (
      <DeletedEntry
        {...props}
        scope={scope}
        refusal={load.refusal}
        mine={load.draft?.doc ?? null}
      />
    );
  }
  return <LoadedEditor key={entry.entryId} {...props} scope={scope} loaded={load} />;
}

function LoadedEditor({
  deviceId,
  entry: listed,
  sections,
  scope,
  loaded,
  onHandle,
  onSaved,
  onStructureChanged,
  onOpenEntry,
  headerActions,
  onSaveState,
}: EditorProps & { scope: DraftScope; loaded: Loaded }) {
  const title = listed.title;
  const [state, setState] = useState<AutosaveState>({
    status: "saved",
    lastSavedAt: loaded.entry.contentUpdatedAt ?? loaded.entry.updatedAt,
    error: null,
    stopped: false,
  });
  const [conflict, setConflict] = useState<{ refusal: NotebookRefusal; mine: NotebookDoc } | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [deleted, setDeleted] = useState<{ refusal: NotebookRefusal; mine: NotebookDoc } | null>(null);
  const [recovery, setRecovery] = useState<EntryDraft | null>(loaded.draft);
  const autosaveRef = useRef<EntryAutosave | null>(null);
  const copyIdRef = useRef<string | null>(null);
  const callbacks = useRef({ onSaved, onHandle, onSaveState });
  callbacks.current = { onSaved, onHandle, onSaveState };

  // Reported to the page (its top bar shows it), and cleared on close.
  useEffect(() => {
    callbacks.current.onSaveState?.({ state, retry: () => autosaveRef.current?.retry() });
  }, [state]);
  useEffect(() => () => callbacks.current.onSaveState?.(null), []);

  const extensions = useMemo(() => notebookExtensions(), []);
  const editor = useEditor({
    extensions,
    content: loaded.doc,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editable: !loaded.draft,
    editorProps: {
      attributes: {
        class: "re-notebook-doc min-h-[24rem] mx-auto max-w-3xl px-5 sm:px-10 pt-5 pb-16 focus:outline-none",
        "aria-label": `Content of ${title}`,
        "aria-multiline": "true",
        role: "textbox",
      },
    },
    onUpdate: ({ editor: e }) => autosaveRef.current?.update(normalizeDoc(e.getJSON() as NotebookNode)),
  });

  // One autosave per opened entry. Closing the editor (another entry, tab or
  // page) writes the draft and sends what's unsaved one last time.
  useEffect(() => {
    const autosave = new EntryAutosave({
      doc: loaded.doc,
      contentVersion: loaded.entry.contentVersion,
      lastSavedAt: loaded.entry.contentUpdatedAt ?? loaded.entry.updatedAt,
      save: (doc, expected) => saveEntryContent(deviceId, loaded.entry.entryId, doc, expected),
      onState: setState,
      onSaved: (saved) => callbacks.current.onSaved(saved),
      onConflict: (refusal, mine) => {
        setConflict({ refusal, mine });
        setConflictOpen(true);
      },
      onDeleted: (refusal, mine) => setDeleted({ refusal, mine }),
      draft: {
        write: (doc, base) => writeDraft(scope, doc, base),
        clear: () => clearDraft(scope),
      },
    });
    autosaveRef.current = autosave;
    const handle: EditorHandle = {
      hasUnsaved: () => autosave.hasUnsaved(),
      flush: () => autosave.flush(),
      contentVersion: () => autosave.contentVersion,
      discard: () => autosave.abandon(),
    };
    const unregister = registerPendingWork(handle);
    callbacks.current.onHandle(handle);

    function beforeUnload(e: BeforeUnloadEvent) {
      autosave.writeDraftNow();
      if (autosave.hasUnsaved()) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    function pageHide() {
      autosave.writeDraftNow();
    }
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", pageHide);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pageHide);
      unregister();
      callbacks.current.onHandle(null);
      autosave.dispose();
      if (autosaveRef.current === autosave) autosaveRef.current = null;
    };
  }, [deviceId, loaded, scope]);

  const blocked = !!conflict || !!deleted || !!recovery;
  useEffect(() => {
    // Read-only while a decision is pending or saving can't continue (lost
    // access); an invalid document stays editable so it can be fixed.
    if (editor && !editor.isDestroyed) editor.setEditable(!blocked && !state.stopped, false);
  }, [editor, blocked, state.stopped]);

  // The workspace can't be switched while changes are unsaved.
  useScopeLock(state.status !== "saved");

  const replaceContent = useCallback(
    (doc: NotebookDoc) => {
      if (editor && !editor.isDestroyed) editor.commands.setContent(doc, { emitUpdate: false });
    },
    [editor]
  );

  /** Saves `mine` as a new entry in `sectionId`; returns an error message or null. */
  const saveCopy = useCallback(
    async (sectionId: string, suffix: string, mine: NotebookDoc): Promise<string | null> => {
      try {
        if (!copyIdRef.current) {
          const base = title.slice(0, 200 - suffix.length);
          copyIdRef.current = (await createEntry(deviceId, sectionId, `${base}${suffix}`)).entryId;
        }
        await saveEntryContent(deviceId, copyIdRef.current, mine, 1);
        onStructureChanged();
        return null;
      } catch (err) {
        onStructureChanged();
        return `Couldn't save your version as a new entry: ${notebookErrorMessage(err)}. It is still kept here.`;
      }
    },
    [deviceId, onStructureChanged, title]
  );

  function acceptTheirs() {
    if (!conflict?.refusal.doc || !conflict.refusal.entry) return;
    const theirs = conflict.refusal.entry;
    replaceContent(conflict.refusal.doc);
    autosaveRef.current?.rebase(conflict.refusal.doc, theirs.contentVersion, theirs.contentUpdatedAt);
    onSaved(theirs);
    setConflict(null);
    setConflictOpen(false);
    copyIdRef.current = null;
  }

  const meta = loaded.entry;
  // The listed entry is kept current by the page (saves, renames); the loaded one is as opened.
  const changedAt = listed.contentUpdatedAt ?? listed.updatedAt ?? meta.contentUpdatedAt ?? meta.updatedAt;
  const changedBy = listed.contentUpdatedByName ?? listed.updatedByName ?? meta.contentUpdatedByName;
  const sectionTitle = sections.find((s) => s.sectionId === listed.sectionId)?.title;
  return (
    <div className="flex flex-col min-w-0">
      <header className="mx-auto w-full max-w-3xl px-5 sm:px-10 pt-6 sm:pt-8 pb-4">
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-sm text-slate-500">
            {sectionTitle && (
              <>
                <span className="font-medium text-slate-600">{sectionTitle}</span>
                <span aria-hidden="true"> · </span>
              </>
            )}
            <span title={formatDate(changedAt)}>Updated {formatDate(changedAt)}</span>
            {changedBy && <span> by {changedBy}</span>}
          </p>
          {headerActions}
        </div>
        <h2 className="mt-2 text-2xl sm:text-[1.75rem] sm:leading-tight font-semibold tracking-tight text-slate-900 break-words">
          {title}
        </h2>
        <p className="mt-1.5 text-xs text-slate-500">
          Created by {meta.createdByName ?? "unknown"} · {formatDate(meta.createdAt)}
        </p>
        {!onSaveState && (
          <div className="mt-3">
            <SaveStatus state={state} onRetry={() => autosaveRef.current?.retry()} />
          </div>
        )}
      </header>

      {recovery && (
        <Alert
          tone="warning"
          className="mx-4 sm:mx-6 mt-3"
          action={
            <div className="flex flex-wrap gap-2 shrink-0">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  clearDraft(scope);
                  setRecovery(null);
                }}
              >
                Discard them
              </Button>
              <Button
                size="sm"
                icon={History}
                onClick={() => {
                  replaceContent(recovery.doc);
                  setRecovery(null);
                  autosaveRef.current?.restore(recovery.doc, recovery.baseContentVersion);
                }}
              >
                Restore them
              </Button>
            </div>
          }
        >
          Unsaved changes to this entry from {formatDate(recovery.savedAt)} were found on this browser. Restore them to
          save them now (if the entry has changed since, you&apos;ll see both versions), or discard them.
        </Alert>
      )}

      {conflict && !conflictOpen && (
        <Alert
          className="mx-4 sm:mx-6 mt-3"
          action={
            <Button size="sm" variant="secondary" onClick={() => setConflictOpen(true)}>
              Resolve
            </Button>
          }
        >
          Your changes weren&apos;t saved because someone else saved this entry first. They&apos;re kept on this browser
          until you resolve it.
        </Alert>
      )}

      {deleted && (
        <DeletedBanner
          refusal={deleted.refusal}
          mine={deleted.mine}
          sections={sections}
          sectionId={listed.sectionId}
          onSaveCopy={(sectionId, mine) => saveCopy(sectionId, " (recovered)", mine)}
          onDone={(openId) => {
            // Saved elsewhere or discarded: nothing of it is kept or sent.
            autosaveRef.current?.abandon();
            clearDraft(scope);
            setDeleted(null);
            onStructureChanged();
            onOpenEntry(openId);
          }}
        />
      )}

      {editor ? (
        <div className="relative">
          <EditorToolbar editor={editor} disabled={blocked} />
          <EditorContent editor={editor} />
        </div>
      ) : (
        <LoadingState label="Starting the editor…" />
      )}

      {conflict && conflictOpen && conflict.refusal.doc && conflict.refusal.entry && (
        <ConflictDialog
          title={title}
          mine={conflict.mine}
          theirs={conflict.refusal.doc}
          theirEntry={conflict.refusal.entry}
          onKeepBoth={async () => {
            const failure = await saveCopy(conflict.refusal.entry!.sectionId, " (my version)", conflict.mine);
            if (!failure) acceptTheirs();
            return failure;
          }}
          onUseTheirs={acceptTheirs}
          onClose={() => setConflictOpen(false)}
        />
      )}
    </div>
  );
}

/** An entry that was deleted, opened with (maybe) unsaved changes of it. */
function DeletedEntry({
  refusal,
  mine,
  sections,
  entry,
  deviceId,
  scope,
  onStructureChanged,
  onOpenEntry,
}: EditorProps & { scope: DraftScope; refusal: NotebookRefusal; mine: NotebookDoc | null }) {
  const saveCopy = useCallback(
    async (sectionId: string, doc: NotebookDoc) => {
      try {
        const created = await createEntry(deviceId, sectionId, `${entry.title.slice(0, 188)} (recovered)`);
        await saveEntryContent(deviceId, created.entryId, doc, 1);
        return null;
      } catch (err) {
        return `Couldn't save your version as a new entry: ${notebookErrorMessage(err)}. It is still kept here.`;
      }
    },
    [deviceId, entry.title]
  );
  if (!mine) {
    return (
      <ErrorState
        title="This entry was deleted"
        message={`${refusal.deletedByName ?? "Someone"} deleted it${refusal.deletedAt ? ` on ${formatDate(refusal.deletedAt)}` : ""}.`}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              onStructureChanged();
              onOpenEntry(null);
            }}
          >
            Close
          </Button>
        }
      />
    );
  }
  return (
    <div className="p-4 sm:p-6">
      <DeletedBanner
        refusal={refusal}
        mine={mine}
        sections={sections}
        sectionId={entry.sectionId}
        onSaveCopy={saveCopy}
        onDone={(openId) => {
          clearDraft(scope);
          onStructureChanged();
          onOpenEntry(openId);
        }}
      />
    </div>
  );
}

function DeletedBanner({
  refusal,
  mine,
  sections,
  sectionId,
  onSaveCopy,
  onDone,
}: {
  refusal: NotebookRefusal;
  mine: NotebookDoc;
  sections: NotebookSection[];
  sectionId: string;
  onSaveCopy: (sectionId: string, mine: NotebookDoc) => Promise<string | null>;
  onDone: (openEntryId: string | null) => void;
}) {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const target = sections.find((s) => s.sectionId === sectionId) ?? sections[0];
  const who = refusal.deletedByName ?? "Someone";

  async function saveCopy() {
    if (!target) return;
    setWorking(true);
    const failure = await onSaveCopy(target.sectionId, mine);
    setWorking(false);
    if (failure) setMessage({ tone: "error", text: failure });
    else onDone(null);
  }

  return (
    <div className="mx-4 sm:mx-6 mt-3 space-y-2">
      <Alert>
        {who} deleted this entry{refusal.deletedAt ? ` on ${formatDate(refusal.deletedAt)}` : ""} while you were editing
        it. Your unsaved changes are kept on this browser: save them as a new entry, copy them, or discard them.
      </Alert>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {confirmDiscard ? (
        <Alert
          tone="warning"
          action={
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="secondary" onClick={() => setConfirmDiscard(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" onClick={() => onDone(null)}>
                Discard my changes
              </Button>
            </div>
          }
        >
          Your unsaved changes will be lost.
        </Alert>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void saveCopy()} disabled={working || !target}>
            {working ? "Saving…" : `Save as a new entry${target ? ` in “${target.title}”` : ""}`}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={Copy}
            onClick={() =>
              void navigator.clipboard.writeText(docText(mine)).then(
                () => setMessage({ tone: "success", text: "Copied as plain text." }),
                () => setMessage({ tone: "error", text: "Couldn't copy to the clipboard." })
              )
            }
          >
            Copy my text
          </Button>
          <Button size="sm" variant="secondary" icon={Trash2} onClick={() => setConfirmDiscard(true)} disabled={working}>
            Discard my changes
          </Button>
        </div>
      )}
    </div>
  );
}
