"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, FilePlus2, FolderPlus, NotebookPen, PanelLeft, PanelRight } from "lucide-react";
import type { Device } from "@/lib/devices";
import { findEntry, type NotebookEntry, type NotebookSection } from "@/lib/reNotebook";
import { maxWidthFor } from "@/lib/reNotebookLayout";
import type { Scope } from "@/lib/workspaces";
import { useAuth } from "@/context/AuthContext";
import { useImageUrls } from "@/app/components/images/useImageData";
import { Alert, Button, Dialog, EmptyState, ErrorState, LoadingState, RowActionsMenu } from "@/app/components/ui";
import EntryEditor, { type EditorHandle, type SaveStateReport } from "../EntryEditor";
import { ConfirmDialog, MoveEntryDialog, TitleDialog } from "../NotebookDialogs";
import { useNotebook } from "../useNotebook";
import ContextPanel from "./ContextPanel";
import EntryListPanel, { entryActions } from "./EntryListPanel";
import NotebookTopBar, { CONTEXT_PANEL_REGION, ENTRIES_PANEL_REGION } from "./NotebookTopBar";
import PanelResizer from "./PanelResizer";
import SectionTabs, { ENTRIES_PANEL_ID } from "./SectionTabs";
import type { NavAction } from "./types";
import { usePanelLayout } from "./usePanelLayout";

type DialogState = NavAction | { kind: "newSection" } | null;

/** Space taken by the padding and resize handles around the panels. */
const CHROME_WIDTH = 48;

/**
 * The device's RE Notebook as a full-screen workspace: sections as tabs, the
 * selected section's entries on the left, the open entry in the middle, and
 * the device's images and artifacts on the right. Everyone who can see the
 * device can read and contribute; the backend enforces it.
 *
 * Leaving the open entry (another entry or section, or Back to Device) first
 * saves it; if that isn't possible (offline, a conflict), the user decides
 * whether to leave, and the changes stay as a local draft either way. Panel
 * changes (collapse, resize, Focus Mode, window size) never close the editor.
 */
export default function NotebookWorkspace({
  device,
  scope,
  initialSectionId,
  initialEntryId,
  onLocationChange,
  onBack,
}: {
  device: Device;
  scope: Scope;
  initialSectionId?: string | null;
  initialEntryId?: string | null;
  /** The selected section or open entry changed (for the page's URL). */
  onLocationChange?: (sectionId: string | null, entryId: string | null) => void;
  /** Goes back to the device; called once the open entry is saved or left. */
  onBack: () => void;
}) {
  const { user } = useAuth();
  const nb = useNotebook(device.deviceId);
  const notebook = nb.notebook;
  const panels = usePanelLayout(user?.userId);
  const [selectedId, setSelectedId] = useState<string | null>(initialEntryId ?? null);
  const [sectionId, setSectionId] = useState<string | null>(initialSectionId ?? null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [leaving, setLeaving] = useState<{ proceed: () => void } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [save, setSave] = useState<SaveStateReport | null>(null);
  const [contextLoaded, setContextLoaded] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const handleRef = useRef<EditorHandle | null>(null);
  const lastSelected = useRef<NotebookEntry | null>(null);
  const pickedDefault = useRef(false);
  /**
   * Set in the render after the first pick: the effects that react to the
   * notebook changing must not act on the pick's own pass, while the
   * selection still holds the linked (perhaps missing) entry.
   */
  const [picked, setPicked] = useState(false);
  /** An entry this user is deleting: its disappearance isn't someone else's doing. */
  const deletingRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const entriesHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const contextHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const avatarUrls = useImageUrls(device.profileImageArtifactId ? [device.profileImageArtifactId] : []);

  const selected = findEntry(notebook, selectedId) ?? (lastSelected.current?.entryId === selectedId ? lastSelected.current : null);
  if (selected) lastSelected.current = selected;
  const section = notebook?.sections.find((s) => s.sectionId === sectionId) ?? null;
  const { closeDrawers } = panels;

  const open = useCallback(
    (entryId: string | null, nextSectionId: string | null) => {
      setSelectedId(entryId);
      setSectionId(nextSectionId);
      closeDrawers();
      onLocationChange?.(nextSectionId, entryId);
    },
    [onLocationChange, closeDrawers]
  );

  // Once loaded: the entry from the link if it's there, else the linked
  // section's first entry, else the first entry of the notebook.
  useEffect(() => {
    if (!notebook || pickedDefault.current) return;
    pickedDefault.current = true;
    setPicked(true);
    const linked = findEntry(notebook, selectedId);
    if (linked) {
      setSectionId(linked.sectionId);
      return;
    }
    if (selectedId) setNotice("That entry isn't in the notebook any more.");
    const start =
      notebook.sections.find((s) => s.sectionId === sectionId) ??
      notebook.sections.find((s) => s.entries.length) ??
      notebook.sections[0] ??
      null;
    open(start?.entries[0]?.entryId ?? null, start?.sectionId ?? null);
  }, [notebook, selectedId, sectionId, open]);

  // The section follows the open entry (moved to another section), and a
  // section that's gone (deleted elsewhere) gives way to another one. The
  // URL keeps the entry, which is what a link opens.
  useEffect(() => {
    if (!notebook || !picked) return;
    const current = findEntry(notebook, selectedId);
    if (current && current.sectionId !== sectionId) {
      setSectionId(current.sectionId);
    } else if (!current && !notebook.sections.some((s) => s.sectionId === sectionId)) {
      const fallback = notebook.sections[0]?.sectionId ?? null;
      if (fallback !== sectionId) setSectionId(fallback);
    }
  }, [notebook, picked, selectedId, sectionId]);

  // The open entry left the notebook (deleted by someone else): close it,
  // unless it has unsaved changes, which its editor then deals with.
  useEffect(() => {
    if (!notebook || !selectedId || !picked || findEntry(notebook, selectedId)) return;
    if (handleRef.current?.hasUnsaved()) return;
    if (deletingRef.current !== selectedId) setNotice("The entry you had open was deleted by someone else.");
    open(null, sectionId);
  }, [notebook, picked, selectedId, sectionId, open]);

  /** Runs `proceed` once the open entry is saved (or the user accepts leaving it). */
  async function guard(proceed: () => void) {
    const handle = handleRef.current;
    if (handle?.hasUnsaved() && !(await handle.flush())) {
      setLeaving({ proceed });
      return;
    }
    setNotice(null);
    proceed();
  }

  function selectEntry(entryId: string | null, entrySectionId: string | null) {
    if (entryId === selectedId) {
      closeDrawers();
      return;
    }
    void guard(() => open(entryId, entrySectionId));
  }

  function selectSection(next: NotebookSection) {
    if (next.sectionId === sectionId) return;
    void guard(() => open(next.entries[0]?.entryId ?? null, next.sectionId));
  }

  // The context panel loads its images and artifacts the first time it shows.
  useEffect(() => {
    if (panels.rightShown) setContextLoaded(true);
  }, [panels.rightShown]);

  // The panels' room depends on the window.
  useLayoutEffect(() => {
    const measure = () => setContainerWidth(containerRef.current?.clientWidth ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // A drawer takes focus when it opens and gives it back when it closes.
  const drawer = panels.left === "drawer" ? "left" : panels.right === "drawer" ? "right" : null;
  useEffect(() => {
    if (!drawer) {
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restore?.isConnected) restore.focus();
      return;
    }
    if (!restoreFocusRef.current) restoreFocusRef.current = document.activeElement as HTMLElement | null;
    (drawer === "left" ? entriesHeadingRef : contextHeadingRef).current?.focus();
  }, [drawer]);

  // Keyboard: Escape closes a drawer, then leaves Focus Mode; Ctrl+Alt+[ and
  // Ctrl+Alt+] toggle the side panels, Ctrl+Alt+F Focus Mode. Not while a
  // dialog or menu has the keyboard, and not for AltGr (Ctrl+Alt on some
  // keyboards types characters).
  const { focus, setFocus, toggle } = panels;
  const panelsAvailable = !!notebook && notebook.sections.length > 0;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[role="dialog"], [role="menu"]')) return;
      if (e.key === "Escape") {
        if (drawer) closeDrawers();
        else if (focus) setFocus(false);
        return;
      }
      if (!panelsAvailable || !e.ctrlKey || !e.altKey || e.metaKey || e.getModifierState?.("AltGraph")) return;
      const action =
        e.code === "BracketLeft" ? () => toggle("left")
        : e.code === "BracketRight" ? () => toggle("right")
        : e.code === "KeyF" ? () => setFocus(!focus)
        : null;
      if (!action) return;
      e.preventDefault();
      action();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer, focus, closeDrawers, setFocus, toggle, panelsAvailable]);

  const ready = !!notebook;
  const hasSections = !!notebook && notebook.sections.length > 0;
  const limits = notebook?.limits;
  const entryCount = notebook?.sections.reduce((n, s) => n + s.entries.length, 0) ?? 0;

  // Widths: as remembered, but never so wide that the editor gets too narrow.
  const room = Math.max(0, containerWidth - CHROME_WIDTH);
  const rightInline = panels.right === "inline" && hasSections;
  const leftInline = panels.left === "inline" && hasSections;
  const leftMax = maxWidthFor("left", room, rightInline ? panels.layout.rightWidth : 0);
  const leftWidth = Math.min(panels.layout.leftWidth, leftMax);
  const rightMax = maxWidthFor("right", room, leftInline ? leftWidth : 0);
  const rightWidth = Math.min(panels.layout.rightWidth, rightMax);
  const showLeftRail = hasSections && !panels.focus && panels.viewport !== "mobile" && panels.left === "hidden";
  const showRightRail = hasSections && !panels.focus && panels.viewport === "desktop" && panels.right === "hidden";

  const panelClass = (mode: "inline" | "drawer" | "hidden", side: "left" | "right") =>
    !hasSections || mode === "hidden"
      ? "hidden"
      : mode === "drawer"
        ? `fixed inset-y-0 ${side === "left" ? "left-0 border-r" : "right-0 border-l"} z-40 w-[min(22rem,88vw)] bg-white border-line shadow-pop`
        : "shrink-0 overflow-hidden rounded-xl border border-line bg-white shadow-card";

  return (
    <div className="re-notebook-viewport flex flex-col overflow-hidden">
      <NotebookTopBar
        device={device}
        scope={scope}
        avatarUrls={avatarUrls}
        save={save}
        focus={panels.focus}
        leftShown={panels.leftShown}
        rightShown={panels.rightShown}
        showPanelToggles={hasSections}
        onBack={() => void guard(onBack)}
        onToggleLeft={() => panels.toggle("left")}
        onToggleRight={() => panels.toggle("right")}
        onFocus={panels.setFocus}
      />

      {hasSections && !panels.focus && (
        <SectionTabs
          notebook={notebook}
          activeSectionId={sectionId}
          busy={nb.busy}
          onSelect={selectSection}
          onAction={setDialog}
          onMoveSection={(index, delta) => void nb.moveSection(index, delta)}
          onNewSection={() => setDialog({ kind: "newSection" })}
        />
      )}

      {(nb.error || notice) && (
        <div className="space-y-2 px-2 pt-2 sm:px-3 sm:pt-3">
          {nb.error && <Alert onDismiss={nb.dismissError}>{nb.error}</Alert>}
          {notice && (
            <Alert tone="info" onDismiss={() => setNotice(null)}>
              {notice}
            </Alert>
          )}
        </div>
      )}

      <div ref={containerRef} className="relative flex min-h-0 flex-1 p-2 sm:p-3">
        {showLeftRail && (
          <PanelRail side="left" label="Show the entries panel" controls={ENTRIES_PANEL_REGION} onClick={() => panels.toggle("left")} />
        )}
        <aside
          id={ENTRIES_PANEL_REGION}
          aria-label="Entries"
          className={panelClass(panels.left, "left")}
          style={panels.left === "inline" ? { width: leftWidth } : undefined}
        >
          {hasSections && (
            <div
              id={ENTRIES_PANEL_ID}
              role="tabpanel"
              aria-labelledby={section ? `re-notebook-section-${section.sectionId}` : undefined}
              className="h-full"
            >
              <EntryListPanel
                ref={entriesHeadingRef}
                notebook={notebook}
                section={section}
                selectedEntryId={selectedId}
                busy={nb.busy}
                onClose={panels.left === "drawer" ? closeDrawers : undefined}
                onSelect={(entry) => selectEntry(entry.entryId, entry.sectionId)}
                onAction={setDialog}
                onMoveEntry={(s, index, delta) => void nb.moveEntryWithin(s, index, delta)}
              />
            </div>
          )}
        </aside>
        {leftInline && (
          <PanelResizer
            side="left"
            label="Resize the entries panel"
            controls={ENTRIES_PANEL_REGION}
            width={leftWidth}
            max={leftMax}
            onResize={(width, remember) => panels.setWidth("left", width, remember)}
          />
        )}

        <main
          id="main-content"
          tabIndex={-1}
          aria-label="Entry"
          className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-line bg-white shadow-card focus:outline-none"
        >
          {!ready ? (
            nb.loadError ? (
              <ErrorState
                title="Couldn't load the RE Notebook"
                message={nb.loadError}
                action={
                  <Button variant="secondary" onClick={() => void nb.reload()}>
                    Try again
                  </Button>
                }
              />
            ) : (
              <LoadingState label="Loading the RE Notebook…" />
            )
          ) : !hasSections ? (
            <EmptyState
              className="py-16"
              icon={NotebookPen}
              title="Start this device's RE Notebook"
              description="Organize your reverse-engineering research into sections (for example Physical Teardown, Firmware Analysis, Vulnerability Investigation), each with its own entries. Everyone with access to this device can read and contribute."
              action={
                <Button icon={FolderPlus} onClick={() => setDialog({ kind: "newSection" })}>
                  Create the first section
                </Button>
              }
            />
          ) : selected && user ? (
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
              onOpenEntry={(entryId) => open(entryId, entryId ? findEntry(notebook, entryId)?.sectionId ?? sectionId : sectionId)}
              onSaveState={setSave}
              headerActions={
                findEntry(notebook, selected.entryId) && (
                  <RowActionsMenu
                    label="Entry actions"
                    disabled={nb.busy}
                    actions={entryActions(findEntry(notebook, selected.entryId)!, notebook, setDialog, (s, i, d) =>
                      void nb.moveEntryWithin(s, i, d)
                    )}
                  />
                )
              }
            />
          ) : (
            <EmptyState
              className="py-16"
              icon={BookOpen}
              title={section && !section.entries.length ? `No entries in ${section.title} yet` : entryCount ? "Select an entry" : "No entries yet"}
              description={
                section && !section.entries.length
                  ? "Add an entry to start writing. Entries save automatically as you type."
                  : "Choose an entry from the list to read or edit it."
              }
              action={
                section && !section.entries.length ? (
                  <Button icon={FilePlus2} disabled={nb.busy} onClick={() => setDialog({ kind: "newEntry", section })}>
                    New entry
                  </Button>
                ) : panels.left === "hidden" && !panels.focus ? (
                  <Button variant="secondary" icon={PanelLeft} onClick={() => panels.toggle("left")}>
                    Show entries
                  </Button>
                ) : undefined
              }
            />
          )}
        </main>

        {rightInline && (
          <PanelResizer
            side="right"
            label="Resize the device context panel"
            controls={CONTEXT_PANEL_REGION}
            width={rightWidth}
            max={rightMax}
            onResize={(width, remember) => panels.setWidth("right", width, remember)}
          />
        )}
        <aside
          id={CONTEXT_PANEL_REGION}
          aria-label="Device context"
          className={panelClass(panels.right, "right")}
          style={panels.right === "inline" ? { width: rightWidth } : undefined}
        >
          {hasSections && contextLoaded && (
            <ContextPanel ref={contextHeadingRef} device={device} onClose={panels.right === "drawer" ? closeDrawers : undefined} />
          )}
        </aside>
        {showRightRail && (
          <PanelRail
            side="right"
            label="Show the device context panel"
            controls={CONTEXT_PANEL_REGION}
            onClick={() => panels.toggle("right")}
          />
        )}

        {drawer && <div className="fixed inset-0 z-30 bg-slate-900/30" aria-hidden="true" onClick={closeDrawers} />}
      </div>

      {dialog?.kind === "newSection" && limits && (
        <TitleDialog
          title="New section"
          label="Section title"
          submitLabel="Create section"
          maxLength={limits.titleLength}
          onSubmit={async (title) => {
            // The new section opens, once the open entry is saved (or left).
            const created = await nb.addSection(title);
            if (created) void guard(() => open(null, created));
            return !!created;
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "renameSection" && limits && (
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
      {dialog?.kind === "newEntry" && limits && (
        <TitleDialog
          title="New entry"
          label={`Entry title (in “${dialog.section.title}”)`}
          submitLabel="Create entry"
          maxLength={limits.titleLength}
          onSubmit={async (title) => {
            const entryId = await nb.addEntry(dialog.section.sectionId, title);
            if (entryId) selectEntry(entryId, dialog.section.sectionId);
            return !!entryId;
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "renameEntry" && notebook && limits && (
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
      {dialog?.kind === "moveEntry" && notebook && (
        <MoveEntryDialog
          notebook={notebook}
          entry={dialog.entry}
          onMove={(target) => nb.moveEntryTo(findEntry(notebook, dialog.entry.entryId) ?? dialog.entry, target)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "deleteEntry" && notebook && (
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
            if (done && entry.entryId === selectedId) open(null, entry.sectionId);
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
                  const { proceed } = leaving;
                  setLeaving(null);
                  proceed();
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

/** A collapsed side panel: a slim strip that brings it back. */
function PanelRail({
  side,
  label,
  controls,
  onClick,
}: {
  side: "left" | "right";
  label: string;
  controls: string;
  onClick: () => void;
}) {
  const Icon = side === "left" ? PanelLeft : PanelRight;
  return (
    <div className={`shrink-0 ${side === "left" ? "mr-3" : "ml-3"}`}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={false}
        aria-controls={controls}
        title={label}
        onClick={onClick}
        className="h-10 w-10 inline-flex items-center justify-center rounded-xl border border-line bg-white text-slate-500 shadow-card hover:text-slate-900 hover:bg-surface-muted outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>
    </div>
  );
}
