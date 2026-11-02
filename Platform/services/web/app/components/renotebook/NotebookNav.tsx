"use client";

import { ArrowDown, ArrowUp, FilePlus2, FileText, FolderInput, Pencil, Trash2 } from "lucide-react";
import type { Notebook, NotebookEntry, NotebookSection } from "@/lib/reNotebook";
import { RowActionsMenu } from "@/app/components/ui";

export type NavAction =
  | { kind: "newEntry"; section: NotebookSection }
  | { kind: "renameSection"; section: NotebookSection }
  | { kind: "deleteSection"; section: NotebookSection }
  | { kind: "renameEntry"; entry: NotebookEntry }
  | { kind: "moveEntry"; entry: NotebookEntry }
  | { kind: "deleteEntry"; entry: NotebookEntry };

/**
 * The notebook's sections and their entries, in order. Every section and
 * entry has a menu (rename, move up/down, move to another section, delete),
 * so reordering works with the keyboard and on touch screens alike.
 */
export default function NotebookNav({
  notebook,
  selectedEntryId,
  busy,
  onSelect,
  onAction,
  onMoveSection,
  onMoveEntry,
}: {
  notebook: Notebook;
  selectedEntryId: string | null;
  busy: boolean;
  onSelect: (entry: NotebookEntry) => void;
  onAction: (action: NavAction) => void;
  onMoveSection: (index: number, delta: -1 | 1) => void;
  onMoveEntry: (section: NotebookSection, index: number, delta: -1 | 1) => void;
}) {
  const sections = notebook.sections;
  return (
    <nav aria-label="Notebook sections and entries">
      <ol className="space-y-3">
        {sections.map((section, sectionIndex) => {
          const full = section.entries.length >= notebook.limits.entriesPerSection;
          return (
            <li key={section.sectionId} aria-label={`Section ${section.title}`}>
              <div className="flex items-center gap-1 pl-2">
                <h3 className="flex-1 min-w-0 text-xs font-semibold uppercase tracking-wide text-slate-500 break-words py-1">
                  {section.title}
                  <span className="sr-only">, {section.entries.length} entries</span>
                </h3>
                <span className="text-[11px] text-slate-400 tabular-nums" aria-hidden="true">
                  {section.entries.length}
                </span>
                <RowActionsMenu
                  label={`Actions for section ${section.title}`}
                  disabled={busy}
                  actions={[
                    !full && { label: "New entry", icon: FilePlus2, onSelect: () => onAction({ kind: "newEntry", section }) },
                    { label: "Rename section", icon: Pencil, onSelect: () => onAction({ kind: "renameSection", section }) },
                    sectionIndex > 0 && {
                      label: "Move section up",
                      icon: ArrowUp,
                      onSelect: () => onMoveSection(sectionIndex, -1),
                    },
                    sectionIndex < sections.length - 1 && {
                      label: "Move section down",
                      icon: ArrowDown,
                      onSelect: () => onMoveSection(sectionIndex, 1),
                    },
                    {
                      label: section.entries.length ? "Delete section (empty it first)" : "Delete section",
                      icon: Trash2,
                      danger: true,
                      disabled: section.entries.length > 0,
                      onSelect: () => onAction({ kind: "deleteSection", section }),
                    },
                  ]}
                />
              </div>
              {section.entries.length ? (
                <ol className="mt-1 space-y-0.5">
                  {section.entries.map((entry, index) => {
                    const selected = entry.entryId === selectedEntryId;
                    return (
                      <li key={entry.entryId} className="group flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onSelect(entry)}
                          aria-current={selected ? "page" : undefined}
                          className={`flex-1 min-w-0 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                            selected
                              ? "bg-brand-50 text-brand-800 font-medium"
                              : "text-slate-700 hover:bg-surface-sunken"
                          }`}
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
                          <span className="min-w-0 break-words">{entry.title}</span>
                        </button>
                        <RowActionsMenu
                          label={`Actions for entry ${entry.title}`}
                          disabled={busy}
                          actions={[
                            { label: "Rename entry", icon: Pencil, onSelect: () => onAction({ kind: "renameEntry", entry }) },
                            index > 0 && { label: "Move up", icon: ArrowUp, onSelect: () => onMoveEntry(section, index, -1) },
                            index < section.entries.length - 1 && {
                              label: "Move down",
                              icon: ArrowDown,
                              onSelect: () => onMoveEntry(section, index, 1),
                            },
                            sections.length > 1 && {
                              label: "Move to section…",
                              icon: FolderInput,
                              onSelect: () => onAction({ kind: "moveEntry", entry }),
                            },
                            {
                              label: "Delete entry",
                              icon: Trash2,
                              danger: true,
                              onSelect: () => onAction({ kind: "deleteEntry", entry }),
                            },
                          ]}
                        />
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="mt-1 ml-2 rounded-lg border border-dashed border-line px-3 py-2 text-xs text-slate-500">
                  No entries yet.{" "}
                  <button
                    type="button"
                    className="font-medium text-brand-700 hover:underline disabled:opacity-50"
                    disabled={busy}
                    onClick={() => onAction({ kind: "newEntry", section })}
                  >
                    Add an entry
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
