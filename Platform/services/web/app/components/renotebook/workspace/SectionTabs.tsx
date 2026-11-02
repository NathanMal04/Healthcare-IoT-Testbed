"use client";

import { useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight, FilePlus2, Pencil, Plus, Trash2 } from "lucide-react";
import type { Notebook, NotebookSection } from "@/lib/reNotebook";
import { Button, RowActionsMenu } from "@/app/components/ui";
import type { NavAction } from "./types";

export const ENTRIES_PANEL_ID = "re-notebook-entries";

/**
 * The notebook's sections as a row of tabs (scrolls sideways when they don't
 * fit). Arrow keys, Home and End move between tabs; the selected section's
 * actions (rename, move left/right, delete when empty) are in the menu
 * after the tabs, and new sections and entries are added from here.
 */
export default function SectionTabs({
  notebook,
  activeSectionId,
  busy,
  onSelect,
  onAction,
  onMoveSection,
  onNewSection,
}: {
  notebook: Notebook;
  activeSectionId: string | null;
  busy: boolean;
  onSelect: (section: NotebookSection) => void;
  onAction: (action: NavAction) => void;
  onMoveSection: (index: number, delta: -1 | 1) => void;
  onNewSection: () => void;
}) {
  const sections = notebook.sections;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = sections.findIndex((s) => s.sectionId === activeSectionId);
  const active = activeIndex >= 0 ? sections[activeIndex] : null;
  const canAddSection = sections.length < notebook.limits.sections;
  const full = !!active && active.entries.length >= notebook.limits.entriesPerSection;

  // The selected tab stays in view when the row scrolls (narrow screens, many sections).
  useEffect(() => {
    if (activeIndex >= 0) tabRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeIndex]);

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const last = sections.length - 1;
    const next =
      e.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    tabRefs.current[next]?.focus();
    onSelect(sections[next]);
  }

  return (
    <div className="flex items-center gap-2 px-3 sm:px-4 bg-white border-b border-line">
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div role="tablist" aria-label="Notebook sections" className="flex min-w-max gap-1">
          {sections.map((section, index) => {
            const selected = section.sectionId === activeSectionId;
            return (
              <button
                key={section.sectionId}
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={`re-notebook-section-${section.sectionId}`}
                aria-selected={selected}
                aria-controls={ENTRIES_PANEL_ID}
                tabIndex={selected || (activeIndex < 0 && index === 0) ? 0 : -1}
                onClick={() => onSelect(section)}
                onKeyDown={(e) => onKeyDown(e, index)}
                title={section.title}
                className={`relative max-w-[16rem] truncate px-3.5 py-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-inset rounded-t-md ${
                  selected ? "text-brand-700" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {section.title}
                <span className={`ml-1.5 text-2xs tabular-nums ${selected ? "text-brand-600" : "text-slate-400"}`}>
                  {section.entries.length}
                </span>
                {selected && <span className="absolute inset-x-2 bottom-0 h-0.5 bg-brand-600 rounded-full" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 py-1.5">
        {active && (
          <RowActionsMenu
            label={`Actions for section ${active.title}`}
            disabled={busy}
            actions={[
              { label: "Rename section", icon: Pencil, onSelect: () => onAction({ kind: "renameSection", section: active }) },
              activeIndex > 0 && {
                label: "Move section left",
                icon: ArrowLeft,
                onSelect: () => onMoveSection(activeIndex, -1),
              },
              activeIndex < sections.length - 1 && {
                label: "Move section right",
                icon: ArrowRight,
                onSelect: () => onMoveSection(activeIndex, 1),
              },
              {
                label: active.entries.length ? "Delete section (empty it first)" : "Delete section",
                icon: Trash2,
                danger: true,
                disabled: active.entries.length > 0,
                onSelect: () => onAction({ kind: "deleteSection", section: active }),
              },
            ]}
          />
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={Plus}
          disabled={!canAddSection || busy}
          title={canAddSection ? undefined : `At most ${notebook.limits.sections} sections`}
          onClick={onNewSection}
        >
          <span className="sr-only sm:not-sr-only">Add section</span>
        </Button>
        {active && (
          <Button
            size="sm"
            icon={FilePlus2}
            disabled={full || busy}
            title={full ? `At most ${notebook.limits.entriesPerSection} entries per section` : undefined}
            onClick={() => onAction({ kind: "newEntry", section: active })}
          >
            <span className="sr-only sm:not-sr-only">New entry</span>
          </Button>
        )}
      </div>
    </div>
  );
}
