"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, FolderPlus, ListTree, NotebookPen } from "lucide-react";
import type { Device } from "@/lib/devices";
import { findEntry, type NotebookEntry } from "@/lib/reNotebook";
import { useAuth } from "@/context/AuthContext";
import { Alert, Button, Dialog, EmptyState, ErrorState, LoadingState, cardClass } from "@/app/components/ui";
import EntryEditor, { type EditorHandle } from "./EntryEditor";
import NotebookNav, { type NavAction } from "./NotebookNav";
import { ConfirmDialog, MoveEntryDialog, TitleDialog } from "./NotebookDialogs";
import { useNotebook } from "./useNotebook";

type DialogState = NavAction | { kind: "newSection" } | null;

/**
 * The device's RE Notebook (one per device): its sections and entries on the
 * left (above, on small screens), the open entry on the right. Everyone who
 * can see the device can read and contribute; the backend enforces it.
 *
 * Switching to another entry first saves the open one; if that isn't possible
 * (offline, a conflict), the user decides whether to leave, and the changes
 * stay as a local draft either way.
 */
export default function DeviceNotebook({
  device,
  initialEntryId,
  onEntryChange,
}: {
  device: Device;
  initialEntryId?: string | null;
  /** The open entry changed (for the page's URL). */
  onEntryChange?: (entryId: string | null) => void;
}) {
  const { user } = useAuth();
  const nb = useNotebook(device.deviceId);
  const notebook = nb.notebook;
  const [selectedId, setSelectedId] = useState<string | null>(initialEntryId ?? null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [leaving, setLeaving] = useState<{ next: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const lastSelected = useRef<NotebookEntry | null>(null);
  const pickedDefault = useRef(false);
  /** An entry this user is deleting: its disappearance isn't someone else's doing. */
  const deletingRef = useRef<string | null>(null);

  const selected = findEntry(notebook, selectedId) ?? (lastSelected.current?.entryId === selectedId ? lastSelected.current : null);
  if (selected) lastSelected.current = selected;

  const open = useCallback(
    (entryId: string | null) => {
      setSelectedId(entryId);
      setNavOpen(false);
      onEntryChange?.(entryId);
    },
    [onEntryChange]
  );

  // Once loaded: the entry from the link if it's there, else the first one.
  useEffect(() => {
    if (!notebook || pickedDefault.current) return;
    pickedDefault.current = true;
    if (selectedId && findEntry(notebook, selectedId)) return;
    if (selectedId) setNotice("That entry isn't in the notebook any more.");
    open(notebook.sections.find((s) => s.entries.length)?.entries[0]?.entryId ?? null);
  }, [notebook, selectedId, open]);

  // The open entry left the notebook (deleted by someone else): close it,
  // unless it has unsaved changes, which its editor then deals with.
  useEffect(() => {
    if (!notebook || !selectedId || !pickedDefault.current || findEntry(notebook, selectedId)) return;
    if (handleRef.current?.hasUnsaved()) return;
    if (deletingRef.current !== selectedId) setNotice("The entry you had open was deleted by someone else.");
    open(null);
  }, [notebook, selectedId, open]);

  /** Opens another entry once the open one is saved (or the user accepts leaving it). */
  async function select(entryId: string | null) {
    if (entryId === selectedId) {
      setNavOpen(false);
      return;
    }
    const handle = handleRef.current;
    if (handle?.hasUnsaved() && !(await handle.flush())) {
      setLeaving({ next: entryId });
      return;
    }
    setNotice(null);
    open(entryId);
  }

  if (nb.loadError && !notebook) {
    return (
      <ErrorState
        title="Couldn't load the RE Notebook"
        message={nb.loadError}
        action={
          <Button variant="secondary" onClick={() => void nb.reload()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!notebook) return <LoadingState label="Loading the RE Notebook…" />;

  const limits = notebook.limits;
  const canAddSection = notebook.sections.length < limits.sections;
  const entryCount = notebook.sections.reduce((n, s) => n + s.entries.length, 0);

  return (
    <div className="space-y-3">
      {nb.error && <Alert onDismiss={nb.dismissError}>{nb.error}</Alert>}
      {notice && (
        <Alert tone="info" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      {notebook.sections.length === 0 ? (
        <div className={cardClass}>
          <EmptyState
            icon={NotebookPen}
            title="Start this device's RE Notebook"
            description="Organize your reverse-engineering research into sections (for example Physical Teardown, Firmware Analysis, Vulnerability Investigation), each with its own entries. Everyone with access to this device can read and contribute."
            action={
              <Button icon={FolderPlus} onClick={() => setDialog({ kind: "newSection" })}>
                Create the first section
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)] items-start">
          <Button
            variant="secondary"
            icon={ListTree}
            className="lg:hidden justify-start"
            aria-expanded={navOpen}
            aria-controls="re-notebook-nav"
            onClick={() => setNavOpen((v) => !v)}
          >
            <span className="truncate">{selected ? selected.title : "Sections and entries"}</span>
            <span className="ml-auto text-xs text-slate-400">
              {notebook.sections.length} sections · {entryCount} entries
            </span>
          </Button>
          <aside
            id="re-notebook-nav"
            className={`${cardClass} p-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto ${navOpen ? "" : "hidden lg:block"}`}
          >
            <div className="flex items-center justify-between gap-2 px-2 pb-2 mb-2 border-b border-line">
              <span className="text-sm font-semibold text-slate-800">RE Notebook</span>
              <Button
                size="sm"
                variant="ghost"
                icon={FolderPlus}
                disabled={!canAddSection || nb.busy}
                title={canAddSection ? undefined : `At most ${limits.sections} sections`}
                onClick={() => setDialog({ kind: "newSection" })}
              >
                New section
              </Button>
            </div>
            <NotebookNav
              notebook={notebook}
              selectedEntryId={selectedId}
              busy={nb.busy}
              onSelect={(entry) => void select(entry.entryId)}
              onAction={setDialog}
              onMoveSection={(index, delta) => void nb.moveSection(index, delta)}
              onMoveEntry={(section, index, delta) => void nb.moveEntryWithin(section, index, delta)}
            />
          </aside>

          <div className={`${cardClass} min-w-0 overflow-hidden`}>
            {selected && user ? (
              <EntryEditor
                key={selected.entryId}
                deviceId={device.deviceId}
                userId={user.userId}
                entry={selected}
                sections={notebook.sections}
                onHandle={(handle) => {
                  handleRef.current = handle;
                }}
                onSaved={nb.applyEntry}
                onStructureChanged={() => void nb.reload()}
                onOpenEntry={open}
              />
            ) : (
              <EmptyState
                icon={BookOpen}
                title={entryCount ? "Select an entry" : "No entries yet"}
                description={
                  entryCount
                    ? "Choose an entry from the list to read or edit it."
                    : "Add an entry to a section to start writing. Entries save automatically as you type."
                }
              />
            )}
          </div>
        </div>
      )}

      {dialog?.kind === "newSection" && (
        <TitleDialog
          title="New section"
          label="Section title"
          submitLabel="Create section"
          maxLength={limits.titleLength}
          onSubmit={async (title) => !!(await nb.addSection(title))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "renameSection" && (
        <TitleDialog
          title="Rename section"
          label="Section title"
          initial={dialog.section.title}
          submitLabel="Rename"
          maxLength={limits.titleLength}
          onSubmit={(title) => nb.renameSection(dialog.section, title)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "deleteSection" && (
        <ConfirmDialog
          title="Delete section?"
          confirmLabel="Delete section"
          onConfirm={() => nb.deleteSection(dialog.section)}
          onClose={() => setDialog(null)}
        >
          <p>
            “{dialog.section.title}” is empty and will be removed from the notebook. Only empty sections can be deleted.
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === "newEntry" && (
        <TitleDialog
          title="New entry"
          label={`Entry title (in “${dialog.section.title}”)`}
          submitLabel="Create entry"
          maxLength={limits.titleLength}
          onSubmit={async (title) => {
            const entryId = await nb.addEntry(dialog.section.sectionId, title);
            if (entryId) void select(entryId);
            return !!entryId;
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "renameEntry" && (
        <TitleDialog
          title="Rename entry"
          label="Entry title"
          initial={dialog.entry.title}
          submitLabel="Rename"
          maxLength={limits.titleLength}
          onSubmit={(title) => nb.renameEntry(findEntry(notebook, dialog.entry.entryId) ?? dialog.entry, title)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "moveEntry" && (
        <MoveEntryDialog
          notebook={notebook}
          entry={dialog.entry}
          onMove={(target) => nb.moveEntryTo(findEntry(notebook, dialog.entry.entryId) ?? dialog.entry, target)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "deleteEntry" && (
        <ConfirmDialog
          title="Delete entry?"
          confirmLabel="Delete entry"
          onConfirm={async () => {
            let entry = findEntry(notebook, dialog.entry.entryId) ?? dialog.entry;
            if (entry.entryId === selectedId && handleRef.current) {
              // The open entry: save it first, and delete what was saved.
              if (!(await handleRef.current.flush())) {
                setDialog(null);
                setNotice("The open entry has changes that couldn't be saved, so it wasn't deleted.");
                return false;
              }
              entry = { ...entry, contentVersion: handleRef.current.contentVersion() };
            }
            deletingRef.current = entry.entryId;
            const done = await nb.deleteEntry(entry);
            if (done && entry.entryId === selectedId) open(null);
            deletingRef.current = null;
            return done;
          }}
          onClose={() => setDialog(null)}
        >
          <p>“{dialog.entry.title}” will be removed from the notebook for everyone with access to this device.</p>
          <p className="text-xs text-slate-500">
            Deleted entries are kept in the database and can be recovered later, but there&apos;s no restore option in
            the app yet.
          </p>
        </ConfirmDialog>
      )}

      {leaving && (
        <Dialog title="Changes not saved yet" onClose={() => setLeaving(null)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              The open entry has changes that couldn&apos;t be saved yet. If you leave it, they stay on this browser as
              a draft and are offered the next time you open the entry.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setLeaving(null)}>
                Stay on this entry
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const next = leaving.next;
                  setLeaving(null);
                  open(next);
                }}
              >
                Leave it
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
