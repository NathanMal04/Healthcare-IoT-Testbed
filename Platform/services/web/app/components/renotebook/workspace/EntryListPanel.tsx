"use client";

import { forwardRef } from "react";
import { ArrowDown, ArrowUp, FilePlus2, FileText, FolderInput, Pencil, Plus, Trash2, X } from "lucide-react";
import type { Notebook, NotebookEntry, NotebookSection } from "@/lib/reNotebook";
import { RowActionsMenu, formatDate, formatDay, initials, type RowAction } from "@/app/components/ui";
import type { NavAction } from "./types";

/** When an entry's content (or else the entry) last changed, and by whom. */
export function entryActivity(entry: NotebookEntry): { at: string | null; by: string | null } {
  return {
    at: entry.contentUpdatedAt ?? entry.updatedAt ?? entry.createdAt,
    by: entry.contentUpdatedByName ?? entry.updatedByName ?? entry.createdByName,
  };
}

/** An entry's actions, shared by the list and the open entry's header. */
export function entryActions(
  entry: NotebookEntry,
  notebook: Notebook,
  onAction: (action: NavAction) => void,
  onMoveEntry: (section: NotebookSection, index: number, delta: -1 | 1) => void
): RowAction[] {
  const section = notebook.sections.find((s) => s.sectionId === entry.sectionId);
  const index = section ? section.entries.findIndex((e) => e.entryId === entry.entryId) : -1;
  const actions: (RowAction | false)[] = [
    { label: "Rename entry", icon: Pencil, onSelect: () => onAction({ kind: "renameEntry", entry }) },
    !!section && index > 0 && { label: "Move up", icon: ArrowUp, onSelect: () => onMoveEntry(section, index, -1) },
    !!section &&
      index >= 0 &&
      index < section.entries.length - 1 && { label: "Move down", icon: ArrowDown, onSelect: () => onMoveEntry(section, index, 1) },
    notebook.sections.length > 1 && {
      label: "Move to section…",
      icon: FolderInput,
      onSelect: () => onAction({ kind: "moveEntry", entry }),
    },
    { label: "Delete entry", icon: Trash2, danger: true, onSelect: () => onAction({ kind: "deleteEntry", entry }) },
  ];
  return actions.filter((a): a is RowAction => !!a);
}

/**
 * The selected section's entries, in order, as a timeline: when each last
 * changed, its title and who changed it. The open entry is highlighted.
 * Each entry has a menu (rename, move up/down, move to another section,
 * delete), so reordering works with the keyboard and on touch screens.
 */
const EntryListPanel = forwardRef<
  HTMLHeadingElement,
  {
    notebook: Notebook;
    section: NotebookSection | null;
    selectedEntryId: string | null;
    busy: boolean;
    /** Shown as a drawer: offers a close button. */
    onClose?: () => void;
    onSelect: (entry: NotebookEntry) => void;
    onAction: (action: NavAction) => void;
    onMoveEntry: (section: NotebookSection, index: number, delta: -1 | 1) => void;
  }
>(function EntryListPanel({ notebook, section, selectedEntryId, busy, onClose, onSelect, onAction, onMoveEntry }, headingRef) {
  const full = !!section && section.entries.length >= notebook.limits.entriesPerSection;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 text-sm font-semibold text-slate-900 outline-none">
          {section ? (
            <>
              <span className="text-slate-500 font-normal">Entries in </span>
              <span className="break-words">{section.title}</span>
            </>
          ) : (
            "Entries"
          )}
        </h2>
        {section && (
          <button
            type="button"
            aria-label={`New entry in ${section.title}`}
            title={full ? `At most ${notebook.limits.entriesPerSection} entries per section` : "New entry"}
            disabled={busy || full}
            onClick={() => onAction({ kind: "newEntry", section })}
            className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:pointer-events-none"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            aria-label="Close the entries panel"
            onClick={onClose}
            className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg text-slate-500 hover:bg-surface-sunken hover:text-slate-900"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!section ? null : section.entries.length ? (
          <nav aria-label={`Entries in ${section.title}`}>
            <ol className="relative py-2">
              {section.entries.map((entry) => {
                const selected = entry.entryId === selectedEntryId;
                const { at, by } = entryActivity(entry);
                const metaId = `re-notebook-entry-meta-${entry.entryId}`;
                return (
                  <li
                    key={entry.entryId}
                    className={`group relative flex items-start transition-colors ${
                      selected ? "bg-brand-50/70" : "hover:bg-surface-muted"
                    }`}
                  >
                    {selected && <span className="absolute inset-y-0 left-0 w-[3px] bg-brand-600" aria-hidden="true" />}
                    <button
                      type="button"
                      onClick={() => onSelect(entry)}
                      aria-current={selected ? "page" : undefined}
                      aria-label={entry.title}
                      aria-describedby={metaId}
                      className="relative flex min-w-0 flex-1 gap-3 py-3 pl-4 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                    >
                      {/* The timeline: a dot per entry on a thin line. */}
                      <span className="relative flex w-3 shrink-0 justify-center self-stretch" aria-hidden="true">
                        <span className="absolute inset-y-[-0.75rem] w-px bg-line group-first:top-4 group-last:bottom-[calc(100%-1.25rem)]" />
                        <span
                          className={`relative mt-1 h-2.5 w-2.5 rounded-full border-2 ${
                            selected ? "border-brand-600 bg-brand-600" : "border-slate-300 bg-white"
                          }`}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span id={metaId} className="block text-xs text-slate-500" title={formatDate(at)}>
                          {formatDay(at)}
                          {by && <span className="sr-only">, last changed by {by}</span>}
                        </span>
                        <span
                          className={`mt-0.5 block text-sm leading-snug break-words ${
                            selected ? "font-semibold text-brand-800" : "font-medium text-slate-800"
                          }`}
                        >
                          {entry.title}
                        </span>
                      </span>
                      {by && (
                        <span
                          className="mt-0.5 h-7 w-7 shrink-0 rounded-full bg-slate-100 text-slate-600 text-2xs font-semibold flex items-center justify-center"
                          title={`Last changed by ${by}`}
                          aria-hidden="true"
                        >
                          {initials(by)}
                        </span>
                      )}
                    </button>
                    <div className="py-2.5 pr-2">
                      <RowActionsMenu
                        label={`Actions for entry ${entry.title}`}
                        disabled={busy}
                        actions={entryActions(entry, notebook, onAction, onMoveEntry)}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          </nav>
        ) : (
          <div className="m-4 rounded-xl border border-dashed border-line px-4 py-6 text-center">
            <FileText className="mx-auto h-5 w-5 text-slate-300" aria-hidden="true" />
            <p className="mt-2 text-sm text-slate-600">No entries yet.</p>
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline disabled:opacity-50"
              disabled={busy}
              onClick={() => onAction({ kind: "newEntry", section })}
            >
              <FilePlus2 className="h-4 w-4" aria-hidden="true" />
              Add an entry
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

export default EntryListPanel;
