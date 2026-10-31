"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefreshCw, ShieldAlert } from "lucide-react";
import type { Device } from "@/lib/devices";
import {
  EMPTY_FILTERS,
  NO_DEVICES,
  SEVERITIES,
  SEVERITY_LABELS,
  descriptionPreview,
  filterCves,
  hasActiveFilters,
  type CveFilters,
  type CveSummary,
  type Severity,
} from "@/lib/cves";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FilterSelect,
  LoadingState,
  SearchInput,
  SeverityBadge,
  Toolbar,
  formatDay,
  type Column,
} from "@/app/components/ui";

// The CVE browsing list (search, filters, table, count), shared by the
// Vulnerabilities page, a device's CVEs tab and the device's Link CVEs
// explorer. The host gives it the CVEs to browse, how a CVE opens, and each
// row's actions; search and filters only ever narrow the CVEs it was given.
// With a selection, rows get checkboxes and a click toggles the row instead.

const MAX_CHIPS_SHOWN = 3;
const MAX_DEVICES_SHOWN = 2;

/** Multi-select over the list's rows, by cveRecordId. */
export interface CveSelection {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** Why a row can't be selected (shown as a badge on it), or null when it can. */
  blocked: (cve: CveSummary) => string | null;
  disabled?: boolean;
}

export default function CveList({
  cves,
  error,
  devices,
  devicesError,
  refreshing,
  onRefresh,
  openHref,
  onOpen,
  actions,
  empty,
  selection,
  autoFocusSearch,
}: {
  /** The CVEs to browse; null while loading. */
  cves: CveSummary[] | null;
  error: string | null;
  /** The scope's devices, which name the CVEs' links and fill the device filter. */
  devices: Device[] | null;
  devicesError: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  /** Where a CVE opens, from its ID or its row. */
  openHref?: (cve: CveSummary) => string;
  /** Opens a CVE in place instead of navigating (used when openHref isn't given). */
  onOpen?: (cve: CveSummary) => void;
  /** The row's actions cell. */
  actions: (cve: CveSummary) => React.ReactNode;
  /** Shown when there are no CVEs at all. */
  empty: React.ReactNode;
  selection?: CveSelection;
  autoFocusSearch?: boolean;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState<CveFilters>(EMPTY_FILTERS);

  const deviceNames = useMemo(() => new Map((devices ?? []).map((d) => [d.deviceId, d.name])), [devices]);
  const sortedDevices = useMemo(
    () => [...(devices ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [devices]
  );
  const linkCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const cve of cves ?? []) for (const id of cve.deviceIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, [cves]);
  const visible = useMemo(() => filterCves(cves ?? [], filters, deviceNames), [cves, filters, deviceNames]);

  function open(cve: CveSummary) {
    if (openHref) router.push(openHref(cve));
    else onOpen?.(cve);
  }

  const idClass = "font-mono text-[13px] font-medium text-brand-700 hover:text-brand-800 hover:underline whitespace-nowrap";
  const columns: Column<CveSummary>[] = [
    ...(selection ? [selectColumn(selection, visible)] : []),
    {
      key: "cve",
      header: "CVE ID",
      cell: (cve) => {
        const blocked = selection?.blocked(cve);
        return (
          <div className="min-w-0 max-w-[16rem] sm:max-w-xs lg:max-w-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {openHref ? (
                <Link href={openHref(cve)} onClick={(e) => e.stopPropagation()} className={idClass}>
                  {cve.cveId}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen?.(cve);
                  }}
                  className={idClass}
                >
                  {cve.cveId}
                </button>
              )}
              {blocked && <Badge>{blocked}</Badge>}
            </div>
            <DescriptionLine description={cve.description} query={filters.text} />
          </div>
        );
      },
    },
    { key: "severity", header: "Severity", cell: (cve) => <SeverityBadge severity={cve.severity} /> },
    {
      key: "cvss",
      header: "CVSS",
      className: "whitespace-nowrap text-slate-700 tabular-nums",
      cell: (cve) =>
        cve.cvssScore === null ? (
          <span className="text-slate-300">—</span>
        ) : (
          <>
            {cve.cvssScore}
            {cve.cvssVersion && <span className="text-xs text-slate-400 ml-1">v{cve.cvssVersion}</span>}
          </>
        ),
    },
    {
      key: "chipsets",
      header: "Affected chipsets",
      hideBelow: "md",
      cell: (cve) => <Chips values={cve.affectedChipsets} max={MAX_CHIPS_SHOWN} className="bg-surface-sunken text-slate-700" />,
    },
    {
      key: "devices",
      header: "Devices",
      cell: (cve) => (
        <Chips
          values={cve.deviceIds.map((id) => deviceNames.get(id) ?? "Unknown device")}
          max={MAX_DEVICES_SHOWN}
          className="bg-brand-50 text-brand-700"
        />
      ),
    },
    {
      key: "updated",
      header: "Updated",
      hideBelow: "lg",
      className: "whitespace-nowrap text-slate-500",
      cell: (cve) => formatDay(cve.updatedAt),
    },
    {
      key: "actions",
      header: "Actions",
      headerClassName: "text-right",
      className: "text-right",
      // Actions are their own controls, never a row click.
      cell: (cve) => <div onClick={(e) => e.stopPropagation()}>{actions(cve)}</div>,
    },
  ];

  function toggle(cve: CveSummary) {
    if (!selection || selection.disabled || selection.blocked(cve)) return;
    const next = new Set(selection.selected);
    if (next.has(cve.cveRecordId)) next.delete(cve.cveRecordId);
    else next.add(cve.cveRecordId);
    selection.onChange(next);
  }

  return (
    <>
      <Toolbar>
        <SearchInput
          value={filters.text}
          onChange={(text) => setFilters((f) => ({ ...f, text }))}
          placeholder="Search CVE, description, chipset, device"
          ariaLabel="Search CVEs"
          autoFocus={autoFocusSearch}
        />
        <FilterSelect
          value={filters.severity}
          onChange={(value) => setFilters((f) => ({ ...f, severity: value as Severity | "" }))}
          ariaLabel="Severity"
        >
          <option value="">All severities</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABELS[s]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          value={filters.device}
          onChange={(device) => setFilters((f) => ({ ...f, device }))}
          ariaLabel="Device"
          className="max-w-[14rem]"
        >
          <option value="">All devices</option>
          <option value={NO_DEVICES}>No devices linked</option>
          {sortedDevices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.name} ({linkCounts.get(d.deviceId) ?? 0})
            </option>
          ))}
        </FilterSelect>
        {hasActiveFilters(filters) && (
          <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear filters
          </Button>
        )}
        <Button variant="ghost" size="sm" icon={RefreshCw} onClick={onRefresh} disabled={refreshing} className="ml-auto">
          Refresh
        </Button>
      </Toolbar>

      {devicesError && cves !== null && (
        <Alert tone="warning" className="mx-5 mt-3">
          {devicesError} Linked devices are shown as &quot;Unknown device&quot;.
        </Alert>
      )}

      {error ? (
        <ErrorState title="Couldn't load CVEs" message={error} />
      ) : cves === null ? (
        <LoadingState label="Loading CVEs…" />
      ) : cves.length === 0 ? (
        empty
      ) : visible.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="No CVEs match these filters"
          action={
            <Button variant="secondary" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={visible}
          rowKey={(cve) => cve.cveRecordId}
          onRowClick={selection ? toggle : open}
          rowLabel={(cve) =>
            selection ? `${selection.selected.has(cve.cveRecordId) ? "Deselect" : "Select"} ${cve.cveId}` : `Open ${cve.cveId}`
          }
          rowClassName={(cve) =>
            selection?.blocked(cve)
              ? "bg-surface-muted/60 [&>td]:opacity-70 cursor-default"
              : selection?.selected.has(cve.cveRecordId)
                ? "bg-brand-50/60"
                : ""
          }
          minWidth="36rem"
        />
      )}

      {cves !== null && cves.length > 0 && !error && (
        <p className="px-5 py-3 text-xs text-slate-500 border-t border-line">
          Showing {visible.length} of {cves.length} CVE{cves.length === 1 ? "" : "s"}
        </p>
      )}
    </>
  );
}

/** The checkbox column; its header selects or clears every selectable row shown. */
function selectColumn(selection: CveSelection, visible: CveSummary[]): Column<CveSummary> {
  const selectable = visible.filter((cve) => !selection.blocked(cve));
  const selectedCount = selectable.filter((cve) => selection.selected.has(cve.cveRecordId)).length;
  const all = selectable.length > 0 && selectedCount === selectable.length;
  return {
    key: "select",
    header: (
      <Checkbox
        checked={all}
        indeterminate={selectedCount > 0 && !all}
        disabled={selection.disabled || selectable.length === 0}
        label={all ? "Deselect all shown CVEs" : "Select all shown CVEs"}
        onChange={() => {
          const next = new Set(selection.selected);
          for (const cve of selectable) {
            if (all) next.delete(cve.cveRecordId);
            else next.add(cve.cveRecordId);
          }
          selection.onChange(next);
        }}
      />
    ),
    headerClassName: "w-10",
    className: "w-10",
    cell: (cve) => {
      const blocked = selection.blocked(cve);
      const selected = !blocked && selection.selected.has(cve.cveRecordId);
      return (
        <Checkbox
          checked={selected}
          disabled={selection.disabled || blocked !== null}
          label={blocked ? `${cve.cveId}: ${blocked}` : `Select ${cve.cveId}`}
          onChange={() => {
            const next = new Set(selection.selected);
            if (selected) next.delete(cve.cveRecordId);
            else next.add(cve.cveRecordId);
            selection.onChange(next);
          }}
        />
      );
    },
  };
}

function Checkbox({
  checked,
  indeterminate = false,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 mt-0.5 accent-brand-600 cursor-pointer disabled:opacity-50 disabled:cursor-default"
    />
  );
}

function Chips({ values, max, className }: { values: string[]; max: number; className: string }) {
  if (!values.length) return <span className="text-slate-300">—</span>;
  const shown = values.slice(0, max);
  return (
    <div className="flex flex-wrap gap-1 max-w-[16rem]">
      {shown.map((value, i) => (
        <span key={`${value}-${i}`} className={`text-xs px-1.5 py-0.5 rounded-md whitespace-nowrap ${className}`}>
          {value}
        </span>
      ))}
      {values.length > max && (
        <span className="text-xs text-slate-400 px-1 py-0.5" title={values.slice(max).join(", ")}>
          +{values.length - max}
        </span>
      )}
    </div>
  );
}

/**
 * One muted line under the CVE ID: the start of the description, or an
 * excerpt around the search text with the matches highlighted. The detail
 * page has the full description.
 */
function DescriptionLine({ description, query }: { description: string | null; query: string }) {
  const preview = descriptionPreview(description, query);
  if (!preview) return <p className="text-xs text-slate-400 italic mt-0.5">No description</p>;
  return (
    <p className="text-xs text-slate-500 mt-0.5 truncate">
      {preview.leading && "…"}
      {preview.parts.map((part, i) =>
        part.match ? (
          <mark key={i} className="bg-amber-100 text-slate-800 rounded-sm px-px">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
      {preview.trailing && "…"}
    </p>
  );
}
