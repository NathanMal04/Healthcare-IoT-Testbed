"use client";

import { LayoutGrid, List, RefreshCw, X, type LucideIcon } from "lucide-react";
import {
  DEVICE_SORT_OPTIONS,
  EMPTY_DEVICE_FILTERS,
  hasActiveDeviceFilters,
  parseSortValue,
  sortValue,
  type DeviceFilters,
  type DeviceSort,
  type DeviceView,
} from "@/lib/deviceList";
import {
  REVERSE_ENGINEERING_STATUSES,
  REVERSE_ENGINEERING_STATUS_LABELS,
  type ReverseEngineeringStatus,
} from "@/lib/reverseEngineering";
import { Button, FilterSelect, SearchInput, Toolbar } from "@/app/components/ui";

const VIEWS: { view: DeviceView; label: string; icon: LucideIcon }[] = [
  { view: "list", label: "List view", icon: List },
  { view: "grid", label: "Grid view", icon: LayoutGrid },
];

/** Two toggle buttons; the pressed one is the current view. */
export function ViewToggle({ view, onChange }: { view: DeviceView; onChange: (view: DeviceView) => void }) {
  return (
    <div role="group" aria-label="Layout" className="inline-flex rounded-lg border border-line bg-surface-muted p-0.5">
      {VIEWS.map(({ view: value, label, icon: Icon }) => {
        const pressed = view === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={pressed}
            aria-label={label}
            title={label}
            onClick={() => onChange(value)}
            className={`h-7 w-8 inline-flex items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              pressed ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

export default function DeviceToolbar({
  filters,
  onFiltersChange,
  manufacturers,
  sort,
  onSortChange,
  view,
  onViewChange,
  onRefresh,
  refreshing,
}: {
  filters: DeviceFilters;
  onFiltersChange: (filters: DeviceFilters) => void;
  /** The scope's manufacturers; the filter is hidden when there are none. */
  manufacturers: string[];
  sort: DeviceSort;
  onSortChange: (sort: DeviceSort) => void;
  view: DeviceView;
  onViewChange: (view: DeviceView) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const set = (changes: Partial<DeviceFilters>) => onFiltersChange({ ...filters, ...changes });
  // A manufacturer chosen before a refresh removed it stays selectable, so the filter never silently changes.
  const manufacturerChoices =
    filters.manufacturer && !manufacturers.includes(filters.manufacturer)
      ? [...manufacturers, filters.manufacturer]
      : manufacturers;

  return (
    <Toolbar>
      <SearchInput
        value={filters.query}
        onChange={(query) => set({ query })}
        placeholder="Search name, manufacturer or model"
        ariaLabel="Search devices by name, manufacturer or model number"
        className="sm:w-80"
      />
      <FilterSelect
        value={filters.status}
        onChange={(value) => set({ status: value as ReverseEngineeringStatus | "" })}
        ariaLabel="Filter by reverse-engineering status"
      >
        <option value="">All RE statuses</option>
        {REVERSE_ENGINEERING_STATUSES.map((status) => (
          <option key={status} value={status}>
            {REVERSE_ENGINEERING_STATUS_LABELS[status]}
          </option>
        ))}
      </FilterSelect>
      {manufacturerChoices.length > 0 && (
        <FilterSelect
          value={filters.manufacturer}
          onChange={(manufacturer) => set({ manufacturer })}
          ariaLabel="Filter by manufacturer"
          className="max-w-[12rem]"
        >
          <option value="">All manufacturers</option>
          {manufacturerChoices.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </FilterSelect>
      )}
      {view === "grid" && (
        <FilterSelect
          value={sortValue(sort)}
          onChange={(value) => {
            const next = parseSortValue(value);
            if (next) onSortChange(next);
          }}
          ariaLabel="Sort devices"
        >
          {DEVICE_SORT_OPTIONS.map((option) => (
            <option key={sortValue(option.sort)} value={sortValue(option.sort)}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
      )}
      {hasActiveDeviceFilters(filters) && (
        <Button variant="ghost" size="sm" icon={X} onClick={() => onFiltersChange(EMPTY_DEVICE_FILTERS)}>
          Clear filters
        </Button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" icon={RefreshCw} onClick={onRefresh} disabled={refreshing}>
          Refresh
        </Button>
        <ViewToggle view={view} onChange={onViewChange} />
      </div>
    </Toolbar>
  );
}
