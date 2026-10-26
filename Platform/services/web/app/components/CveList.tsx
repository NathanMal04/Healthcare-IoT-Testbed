"use client";

import { useMemo, useState } from "react";
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
// Vulnerabilities page and a device's CVEs tab. The host gives it the CVEs
// to browse, where a CVE opens, and each row's actions; search and filters
// only ever narrow the CVEs it was given.

const MAX_CHIPS_SHOWN = 3;
const MAX_DEVICES_SHOWN = 2;

export default function CveList({
  cves,
  error,
  devices,
  devicesError,
  refreshing,
  onRefresh,
  openHref,
  actions,
  empty,
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
  openHref: (cve: CveSummary) => string;
  /** The row's actions cell. */
  actions: (cve: CveSummary) => React.ReactNode;
  /** Shown when there are no CVEs at all. */
  empty: React.ReactNode;
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

  const columns: Column<CveSummary>[] = [
    {
      key: "cve",
      header: "CVE ID",
      cell: (cve) => (
        <div className="min-w-0 max-w-[16rem] sm:max-w-xs lg:max-w-sm">
          <Link
            href={openHref(cve)}
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[13px] font-medium text-brand-700 hover:text-brand-800 hover:underline whitespace-nowrap"
          >
            {cve.cveId}
          </Link>
          <DescriptionLine description={cve.description} query={filters.text} />
        </div>
      ),
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
      cell: actions,
    },
  ];

  return (
    <>
      <Toolbar>
        <SearchInput
          value={filters.text}
          onChange={(text) => setFilters((f) => ({ ...f, text }))}
          placeholder="Search CVE, description, chipset, device"
          ariaLabel="Search CVEs"
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
          onRowClick={(cve) => router.push(openHref(cve))}
          rowLabel={(cve) => `Open ${cve.cveId}`}
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
