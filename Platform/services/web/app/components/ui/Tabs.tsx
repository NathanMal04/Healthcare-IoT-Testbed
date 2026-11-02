"use client";

import { useRef, useState } from "react";

export interface TabItem<Id extends string> {
  id: Id;
  label: string;
  count?: number | string;
}

/**
 * A row (or, `orientation="vertical"`, a column) of tabs; a row scrolls
 * sideways when it doesn't fit. The panel is rendered by the caller.
 *
 * Keyboard (WAI-ARIA tabs): Tab reaches the selected tab only; the arrow
 * keys, Home and End move between tabs. Activation is manual by default:
 * Enter or Space (or a click) selects the focused tab, so moving focus never
 * triggers a tab that loads data or navigates away. `activation="automatic"`
 * selects as focus moves.
 *
 * `idPrefix` keeps tab and panel ids unique when a page has more than one
 * set of tabs; pass the same prefix to TabPanel.
 */
export function Tabs<Id extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
  orientation = "horizontal",
  activation = "manual",
  idPrefix = "",
}: {
  tabs: TabItem<Id>[];
  active: Id;
  onChange: (id: Id) => void;
  ariaLabel: string;
  orientation?: "horizontal" | "vertical";
  activation?: "manual" | "automatic";
  idPrefix?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // The tab keyboard focus is on (roving tabindex); the selected one by default.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === active));
  const current = focusIndex ?? activeIndex;
  const vertical = orientation === "vertical";

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    const prevKey = vertical ? "ArrowUp" : "ArrowLeft";
    const nextKey = vertical ? "ArrowDown" : "ArrowRight";
    const next =
      e.key === nextKey ? (index === last ? 0 : index + 1)
      : e.key === prevKey ? (index === 0 ? last : index - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    setFocusIndex(next);
    refs.current[next]?.focus();
    if (activation === "automatic") onChange(tabs[next].id);
  }

  return (
    <div
      className={vertical ? "" : "border-b border-line overflow-x-auto"}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={orientation}
    >
      <div className={vertical ? "flex flex-col gap-0.5" : "flex gap-1 min-w-max"}>
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`${idPrefix}tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}panel-${tab.id}`}
              tabIndex={index === current ? 0 : -1}
              onClick={() => {
                setFocusIndex(index);
                onChange(tab.id);
              }}
              onKeyDown={(e) => onKeyDown(e, index)}
              onBlur={(e) => {
                // Leaving the tabs: Tab returns to the selected one next time.
                if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) setFocusIndex(null);
              }}
              className={
                vertical
                  ? `relative flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                      selected ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-surface-sunken hover:text-slate-900"
                    }`
                  : `relative px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors rounded-t-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                      selected ? "text-brand-700" : "text-slate-500 hover:text-slate-800"
                    }`
              }
            >
              {vertical && selected && (
                <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand-600" aria-hidden="true" />
              )}
              <span className={vertical ? "min-w-0 flex-1 truncate" : undefined}>{tab.label}</span>
              {tab.count !== undefined && (
                <span
                  className={`${vertical ? "" : "ml-1.5 "}text-2xs px-1.5 py-0.5 rounded-md tabular-nums ${
                    selected ? "bg-brand-50 text-brand-700" : "bg-surface-sunken text-slate-500"
                  } ${vertical && selected ? "bg-white" : ""}`}
                >
                  {tab.count}
                </span>
              )}
              {!vertical && selected && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 bg-brand-600 rounded-full" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The panel for the active tab. */
export function TabPanel({
  id,
  idPrefix = "",
  className = "pt-5",
  children,
}: {
  id: string;
  idPrefix?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="tabpanel" id={`${idPrefix}panel-${id}`} aria-labelledby={`${idPrefix}tab-${id}`} className={className}>
      {children}
    </div>
  );
}
