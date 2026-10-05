"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useWorkspace } from "@/context/WorkspaceContext";
import { getDevices, type Device } from "@/lib/devices";
import { isWorkspaceUnavailable, scopeKey, scopeWorkspaceId } from "@/lib/workspaces";
import {
  EMPTY_FILTERS,
  NO_DEVICES,
  SEVERITIES,
  SEVERITY_LABELS,
  cveErrorMessage,
  filterCves,
  hasActiveFilters,
  listCves,
  type Cve,
  type CveFilters,
  type CveSummary,
  type Severity,
} from "@/lib/cves";
import { AddCveDialog, CveDetailsDialog } from "@/app/components/CveDialogs";
import { SeverityBadge, cardClass, formatDate, primaryButton, useRequireUser } from "@/app/components/ui";

const MAX_CHIPS_SHOWN = 3;
const MAX_DEVICES_SHOWN = 2;

export default function DatabasePage() {
  const { scope, scopeReady } = useWorkspace();
  // Until the saved workspace is restored, nothing scoped mounts, so no
  // Personal requests go out first.
  if (!scopeReady) return <p className="text-sm text-slate-400">Loading workspace…</p>;
  // Keyed on the scope: switching remounts the view, so the list, filters and
  // open dialogs reset, and a late response for the previous scope lands in
  // the unmounted view instead of this one.
  return <DatabaseView key={scopeKey(scope)} />;
}

function DatabaseView() {
  const ready = useRequireUser();
  const { user } = useAuth();
  const { scope, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);

  const [cves, setCves] = useState<CveSummary[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [filters, setFilters] = useState<CveFilters>(EMPTY_FILTERS);
  const [openCve, setOpenCve] = useState<{ id: string; initial?: CveSummary } | null>(null);
  const [adding, setAdding] = useState(false);
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
    setOpenCve(null);
  }, []);

  const onGone = useCallback(
    (cveRecordId: string, message: string) => {
      removeRow(cveRecordId);
      setNotice(message);
    },
    [removeRow]
  );

  function openRow(cve: CveSummary) {
    setNotice(null);
    setOpenCve({ id: cve.cveRecordId, initial: cve });
  }

  if (!ready) return null;

  const scopeName = scope.kind === "workspace" ? scope.name : "Personal";
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Database</h1>
          <p className="text-slate-400 mt-1 text-sm">
            Known vulnerabilities for your devices
            {" · "}
            {scope.kind === "workspace" ? (
              <span className="text-slate-600">
                Workspace: <span className="font-medium">{scope.name}</span>
              </span>
            ) : (
              <span className="text-slate-600">Personal</span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setAdding(true);
          }}
          className={primaryButton}
        >
          + Add CVE
        </button>
      </div>

      {notice && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="text-amber-600 hover:text-amber-800">
            ✕
          </button>
        </div>
      )}

      <div className={`${cardClass} overflow-hidden`}>
        <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-slate-700 mr-auto">
            {scope.kind === "workspace" ? `${scope.name} CVEs` : "Your CVEs"}
          </h2>
          <input
            type="search"
            value={filters.text}
            onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))}
            placeholder="Search CVE, description, chipset, device"
            aria-label="Search CVEs"
            className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 w-full sm:w-72"
          />
          <select
            value={filters.severity}
            onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value as Severity | "" }))}
            aria-label="Severity"
            className="text-sm border border-slate-200 rounded-lg px-2 py-1.5"
          >
            <option value="">All severities</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
          <select
            value={filters.device}
            onChange={(e) => setFilters((f) => ({ ...f, device: e.target.value }))}
            aria-label="Device"
            className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 max-w-[14rem]"
          >
            <option value="">All devices</option>
            <option value={NO_DEVICES}>No devices linked</option>
            {sortedDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.name} ({linkCounts.get(d.deviceId) ?? 0})
              </option>
            ))}
          </select>
          {hasActiveFilters(filters) && (
            <button
              type="button"
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              Clear filters
            </button>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={listLoading}
            className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {devicesError && cves !== null && (
          <p className="text-xs text-amber-700 bg-amber-50 px-6 py-2">
            {devicesError} Linked devices are shown as &quot;Unknown device&quot;.
          </p>
        )}

        {listError ? (
          <div className="px-6 py-8 text-sm text-red-600">{listError}</div>
        ) : cves === null ? (
          <div className="px-6 py-8 text-sm text-slate-400">Loading CVEs…</div>
        ) : cves.length === 0 ? (
          <div className="px-6 py-10 text-sm text-slate-400 text-center">
            No CVEs recorded in {scopeName} yet. Use <span className="font-medium">+ Add CVE</span> to record one.
          </div>
        ) : visible.length === 0 ? (
          <div className="px-6 py-8 text-sm text-slate-400">No CVEs match these filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-100">
                  <th className="pl-6 pr-3 py-3 font-medium text-xs uppercase tracking-wide">CVE ID</th>
                  <th className="px-3 py-3 font-medium text-xs uppercase tracking-wide">Severity</th>
                  <th className="px-3 py-3 font-medium text-xs uppercase tracking-wide">CVSS</th>
                  <th className="hidden md:table-cell px-3 py-3 font-medium text-xs uppercase tracking-wide">
                    Affected chipsets
                  </th>
                  <th className="px-3 py-3 font-medium text-xs uppercase tracking-wide">Devices</th>
                  <th className="hidden lg:table-cell px-6 py-3 font-medium text-xs uppercase tracking-wide">Updated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((cve) => (
                  <tr
                    key={cve.cveRecordId}
                    onClick={() => openRow(cve)}
                    className="border-b border-slate-50 last:border-0 hover:bg-slate-50 cursor-pointer align-top"
                  >
                    <td className="pl-6 pr-3 py-3 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openRow(cve);
                        }}
                        className="font-mono text-blue-700 hover:text-blue-800 font-medium"
                      >
                        {cve.cveId}
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <SeverityBadge severity={cve.severity} />
                    </td>
                    <td className="px-3 py-3 text-slate-600 whitespace-nowrap">
                      {cve.cvssScore === null ? (
                        "—"
                      ) : (
                        <>
                          {cve.cvssScore}
                          {cve.cvssVersion && <span className="text-xs text-slate-400 ml-1">v{cve.cvssVersion}</span>}
                        </>
                      )}
                    </td>
                    <td className="hidden md:table-cell px-3 py-3">
                      <Chips values={cve.affectedChipsets} max={MAX_CHIPS_SHOWN} className="bg-slate-100 text-slate-700" />
                    </td>
                    <td className="px-3 py-3">
                      <Chips
                        values={cve.deviceIds.map((id) => deviceNames.get(id) ?? "Unknown device")}
                        max={MAX_DEVICES_SHOWN}
                        className="bg-indigo-50 text-indigo-700"
                      />
                    </td>
                    <td className="hidden lg:table-cell px-6 py-3 text-slate-500 whitespace-nowrap">
                      {formatDate(cve.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {cves !== null && cves.length > 0 && !listError && (
          <p className="px-6 py-3 text-xs text-slate-400 border-t border-slate-100">
            Showing {visible.length} of {cves.length} CVE{cves.length === 1 ? "" : "s"}
          </p>
        )}
      </div>

      {adding && (
        <AddCveDialog
          scope={scope}
          devices={devices}
          deviceNames={deviceNames}
          onClose={() => setAdding(false)}
          onSaved={upsert}
          onOpenExisting={(id) => {
            setAdding(false);
            setOpenCve({ id, initial: cves?.find((c) => c.cveRecordId === id) });
          }}
        />
      )}

      {openCve && (
        <CveDetailsDialog
          key={openCve.id}
          cveRecordId={openCve.id}
          initial={openCve.initial}
          scope={scope}
          devices={devices}
          deviceNames={deviceNames}
          currentUserId={user?.userId}
          onClose={() => setOpenCve(null)}
          onChanged={upsert}
          onDeleted={removeRow}
          onGone={onGone}
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
        <span key={`${value}-${i}`} className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${className}`}>
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
