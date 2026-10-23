"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/context/WorkspaceContext";
import { getDevices, type Device } from "@/lib/devices";
import { cveHref } from "@/lib/routes";
import { isWorkspaceUnavailable, scopeKey, scopeWorkspaceId } from "@/lib/workspaces";
import {
  EMPTY_FILTERS,
  NO_DEVICES,
  SEVERITIES,
  SEVERITY_LABELS,
  cveErrorMessage,
  descriptionPreview,
  filterCves,
  hasActiveFilters,
  listCves,
  type Cve,
  type CveFilters,
  type CveSummary,
  type Severity,
} from "@/lib/cves";
import { AddCveDialog, DeleteCveDialog } from "@/app/components/CveDialogs";
import { Eye, Link2, Pencil, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  FilterSelect,
  LoadingState,
  PageHeader,
  RowActionsMenu,
  SearchInput,
  SeverityBadge,
  Toolbar,
  formatDay,
  useRequireUser,
  type Column,
} from "@/app/components/ui";

const MAX_CHIPS_SHOWN = 3;
const MAX_DEVICES_SHOWN = 2;

export default function VulnerabilitiesPage() {
  const { scope, scopeReady } = useWorkspace();
  // Until the saved workspace is restored, nothing scoped mounts, so no
  // Personal requests go out first.
  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
  // Keyed on the scope: switching remounts the view, so the list, filters and
  // open dialogs reset, and a late response for the previous scope lands in
  // the unmounted view instead of this one.
  return <VulnerabilitiesView key={scopeKey(scope)} />;
}

function VulnerabilitiesView() {
  const ready = useRequireUser();
  const router = useRouter();
  const { scope, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);

  const [cves, setCves] = useState<CveSummary[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [filters, setFilters] = useState<CveFilters>(EMPTY_FILTERS);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<CveSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Only the latest load may update the page (e.g. Refresh overtaking the first load).
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    const isCurrent = () => isMountedRef.current && loadId === loadIdRef.current;
    setListLoading(true);
    setListError(null);
    // The CVEs and the devices that name their links come from the same scope.
    const [cveResult, deviceResult] = await Promise.allSettled([listCves(workspaceId), getDevices(workspaceId)]);
    if (!isCurrent()) return;
    if (cveResult.status === "fulfilled") {
      setCves(cveResult.value);
    } else {
      setListError(cveErrorMessage(cveResult.reason, "Couldn't load CVEs"));
      if (workspaceId && isWorkspaceUnavailable(cveResult.reason)) reportWorkspaceUnavailable();
    }
    if (deviceResult.status === "fulfilled") {
      setDevices(deviceResult.value);
      setDevicesError(null);
    } else {
      setDevices(null);
      setDevicesError("Device names couldn't be loaded.");
    }
    setListLoading(false);
  }, [workspaceId, reportWorkspaceUnavailable]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

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

  const upsert = useCallback((cve: Cve) => {
    setCves((current) => {
      if (!current) return [cve];
      return current.some((c) => c.cveRecordId === cve.cveRecordId)
        ? current.map((c) => (c.cveRecordId === cve.cveRecordId ? cve : c))
        : [cve, ...current];
    });
  }, []);

  const removeRow = useCallback((cveRecordId: string) => {
    setCves((current) => current?.filter((c) => c.cveRecordId !== cveRecordId) ?? current);
    setDeleting(null);
  }, []);

  // Each CVE opens on its own page.
  function openRow(cve: CveSummary) {
    router.push(cveHref(cve.cveRecordId));
  }

  if (!ready) return null;

  const scopeName = scope.kind === "workspace" ? scope.name : "Personal";
  const columns: Column<CveSummary>[] = [
    {
      key: "cve",
      header: "CVE ID",
      cell: (cve) => (
        <div className="min-w-0 max-w-[16rem] sm:max-w-xs lg:max-w-sm">
          <Link
            href={cveHref(cve.cveRecordId)}
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
      cell: (cve) => (
        <RowActionsMenu
          label={`Actions for ${cve.cveId}`}
          actions={[
            { label: "View details", icon: Eye, href: cveHref(cve.cveRecordId) },
            { label: "Edit CVE", icon: Pencil, href: cveHref(cve.cveRecordId, undefined, { edit: true }) },
            { label: "Link devices", icon: Link2, href: cveHref(cve.cveRecordId, "devices") },
            {
              label: "Delete CVE",
              icon: Trash2,
              danger: true,
              onSelect: () => {
                setNotice(null);
                setDeleting(cve);
              },
            },
          ]}
        />
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Vulnerabilities (CVE)"
        description="Known vulnerabilities recorded against your devices"
        scope={scope}
        actions={
          <Button icon={Plus} onClick={() => setAdding(true)}>
            Add CVE
          </Button>
        }
      />

      {notice && (
        <Alert tone="warning" onDismiss={() => setNotice(null)} className="mb-4">
          {notice}
        </Alert>
      )}

      <Card className="overflow-hidden">
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
          <Button
            variant="ghost"
            size="sm"
            icon={RefreshCw}
            onClick={() => void load()}
            disabled={listLoading}
            className="ml-auto"
          >
            Refresh
          </Button>
        </Toolbar>

        {devicesError && cves !== null && (
          <Alert tone="warning" className="mx-5 mt-3">
            {devicesError} Linked devices are shown as &quot;Unknown device&quot;.
          </Alert>
        )}

        {listError ? (
          <ErrorState title="Couldn't load CVEs" message={listError} />
        ) : cves === null ? (
          <LoadingState label="Loading CVEs…" />
        ) : cves.length === 0 ? (
          <EmptyState
            icon={ShieldAlert}
            title={`No CVEs recorded in ${scopeName} yet`}
            description="Record a known vulnerability and link it to the devices it affects."
            action={
              <Button icon={Plus} onClick={() => setAdding(true)}>
                Add CVE
              </Button>
            }
          />
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
            onRowClick={openRow}
            rowLabel={(cve) => `Open ${cve.cveId}`}
            minWidth="36rem"
          />
        )}

        {cves !== null && cves.length > 0 && !listError && (
          <p className="px-5 py-3 text-xs text-slate-500 border-t border-line">
            Showing {visible.length} of {cves.length} CVE{cves.length === 1 ? "" : "s"}
          </p>
        )}
      </Card>

      {adding && (
        <AddCveDialog
          scope={scope}
          devices={devices}
          deviceNames={deviceNames}
          onClose={() => setAdding(false)}
          onSaved={upsert}
          onOpenExisting={(id) => router.push(cveHref(id))}
        />
      )}

      {deleting && (
        <DeleteCveDialog
          cve={deleting}
          scope={scope}
          onCancel={() => setDeleting(null)}
          onDeleted={removeRow}
          onGone={(id, message) => {
            removeRow(id);
            setNotice(message);
          }}
          onRefreshed={upsert}
        />
      )}

    </div>
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
