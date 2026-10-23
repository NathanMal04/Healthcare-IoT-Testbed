"use client";

export interface TabItem<Id extends string> {
  id: Id;
  label: string;
  count?: number | string;
}

/** A row of tabs; scrolls sideways when it doesn't fit. The panel is rendered by the caller. */
export function Tabs<Id extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
}: {
  tabs: TabItem<Id>[];
  active: Id;
  onChange: (id: Id) => void;
  ariaLabel: string;
}) {
  return (
    <div className="border-b border-line overflow-x-auto" role="tablist" aria-label={ariaLabel}>
      <div className="flex gap-1 min-w-max">
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              onClick={() => onChange(tab.id)}
              className={`relative px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
                selected ? "text-brand-700" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span
                  className={`ml-1.5 text-2xs px-1.5 py-0.5 rounded-md tabular-nums ${
                    selected ? "bg-brand-50 text-brand-700" : "bg-surface-sunken text-slate-500"
                  }`}
                >
                  {tab.count}
                </span>
              )}
              {selected && <span className="absolute inset-x-2 -bottom-px h-0.5 bg-brand-600 rounded-full" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The panel for the active tab. */
export function TabPanel({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="pt-5">
      {children}
    </div>
  );
}
