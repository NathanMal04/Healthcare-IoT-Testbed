"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Cpu, Plus, SearchX } from "lucide-react";
import {
  getDevices,
  updateDeviceReverseEngineeringStatus,
  type Device,
  type ReverseEngineeringStatus,
} from "@/lib/devices";
import { listCves } from "@/lib/cves";
import { reProgress } from "@/lib/dashboard";
import {
  DEFAULT_DEVICE_SORT,
  EMPTY_DEVICE_FILTERS,
  artifactFigure,
  cveCountsByDevice,
  cveFigure,
  filterDeviceList,
  hasActiveDeviceFilters,
  manufacturerOptions,
  readDeviceView,
  sortDeviceList,
  deviceStats,
  writeDeviceView,
  type DeviceFilters,
  type DeviceSort,
  type DeviceView,
} from "@/lib/deviceList";
import { deviceHref } from "@/lib/routes";
import { useAuth } from "@/context/AuthContext";
import { useWorkspace } from "@/context/WorkspaceContext";
import { isWorkspaceUnavailable, scopeKey, scopeWorkspaceId } from "@/lib/workspaces";
import AddDeviceDialog from "@/app/components/AddDeviceDialog";
import EditDeviceDialog from "@/app/components/EditDeviceDialog";
import FirmwareUploadDialog from "@/app/components/firmware/FirmwareUploadDialog";
import { useImageUrls } from "@/app/components/images/useImageData";
import { useMountedRef } from "@/app/components/device/useMountedRef";
import DeviceSummaryCards from "@/app/components/devices/DeviceSummaryCards";
import DeviceToolbar from "@/app/components/devices/DeviceToolbar";
import DeviceListView, { DeviceListSkeleton } from "@/app/components/devices/DeviceListView";
import DeviceGridView, { DeviceGridSkeleton } from "@/app/components/devices/DeviceGridView";
import { useDeviceArtifactCounts } from "@/app/components/devices/useDeviceArtifactCounts";
import type { DeviceActionHandlers } from "@/app/components/devices/parts";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  useLatestRequest,
} from "@/app/components/ui";

export default function DevicesPage() {
  const { scope, scopeReady } = useWorkspace();
  // Until the saved workspace is restored, nothing scoped mounts, so no
  // Personal requests go out first.
  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
  // Keyed on the scope: switching remounts the view, so no devices, counts,
  // errors or dialogs carry over, and a late response for the previous scope
  // lands in the unmounted view instead of this one.
  return <DevicesView key={scopeKey(scope)} />;
}

function DevicesView() {
  const router = useRouter();
  const { user } = useAuth();
  const userId = user?.userId;
  const { scope, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);
  const mountedRef = useMountedRef();
  const latest = useLatestRequest();

  // --- Data: the scope's devices, and its CVEs for the per-device counts ----------
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [cveCounts, setCveCounts] = useState<Map<string, number> | null>(null);
  const [cvesFailed, setCvesFailed] = useState(false);
  // Bumped after each device load, so artifact counts are fetched once per load.
  const [loadCount, setLoadCount] = useState(0);

  const loadDevices = useCallback(async () => {
    const token = latest.begin();
    setDevicesLoading(true);
    setDevicesError(null);
    setCvesFailed(false);
    // Both lists are of this scope only; GET /cves returns every CVE with its
    // linked devices, so the counts are exact.
    const [deviceResult, cveResult] = await Promise.allSettled([getDevices(workspaceId), listCves(workspaceId)]);
    if (!latest.isCurrent(token)) return;

    if (deviceResult.status === "fulfilled") {
      setDevices(deviceResult.value);
      setLoadCount((n) => n + 1);
    } else {
      const err = deviceResult.reason;
      setDevicesError(err instanceof Error ? err.message : "Failed to load devices");
      if (workspaceId && isWorkspaceUnavailable(err)) reportWorkspaceUnavailable();
    }
    if (cveResult.status === "fulfilled") {
      setCveCounts(cveCountsByDevice(cveResult.value));
    } else {
      setCveCounts(null);
      setCvesFailed(true);
    }
    setDevicesLoading(false);
  }, [latest, workspaceId, reportWorkspaceUnavailable]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const deviceIds = useMemo(() => (devices ? devices.map((d) => d.deviceId) : null), [devices]);
  // Keyed on the ids, so a status change or edit (same devices) fetches nothing.
  const artifactCounts = useDeviceArtifactCounts(deviceIds, loadCount);

  // Profile pictures: one view-URL request for every device, shared by both
  // views, so switching views asks for nothing again.
  const profileImageIds = useMemo(
    () => (devices ?? []).flatMap((device) => (device.profileImageArtifactId ? [device.profileImageArtifactId] : [])),
    [devices]
  );
  const profileUrls = useImageUrls(profileImageIds);

  // --- View, search, filters and sort (kept when the view changes) ---------------
  const [view, setView] = useState<DeviceView>(() => readDeviceView(userId));
  const [filters, setFilters] = useState<DeviceFilters>(EMPTY_DEVICE_FILTERS);
  const [sort, setSort] = useState<DeviceSort>(DEFAULT_DEVICE_SORT);

  function changeView(next: DeviceView) {
    setView(next);
    writeDeviceView(userId, next);
  }

  const statsFor = useCallback(
    (device: Device) => deviceStats(device.deviceId, cveCounts, artifactCounts.counts),
    [cveCounts, artifactCounts.counts]
  );
  const figuresFor = useCallback(
    (device: Device) => {
      const stats = statsFor(device);
      return {
        cves: cveFigure(stats.cves, cvesFailed),
        artifacts: artifactFigure(stats.artifacts, artifactCounts.failed.has(device.deviceId)),
      };
    },
    [statsFor, cvesFailed, artifactCounts.failed]
  );

  const progress = useMemo(() => (devices ? reProgress(devices) : null), [devices]);
  const manufacturers = useMemo(() => manufacturerOptions(devices ?? []), [devices]);
  const visible = useMemo(
    () => sortDeviceList(filterDeviceList(devices ?? [], filters), sort, statsFor),
    [devices, filters, sort, statsFor]
  );
  const filtering = hasActiveDeviceFilters(filters);

  // --- Actions --------------------------------------------------------------------
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [uploadDevice, setUploadDevice] = useState<Device | null>(null);
  const [savingStatusIds, setSavingStatusIds] = useState<ReadonlySet<string>>(() => new Set());
  const [statusError, setStatusError] = useState<string | null>(null);

  const handlers: DeviceActionHandlers = useMemo(
    () => ({ onEdit: setEditing, onUploadFirmware: setUploadDevice }),
    []
  );

  function replaceDevice(next: Device) {
    setDevices((current) => current?.map((d) => (d.deviceId === next.deviceId ? next : d)) ?? current);
  }

  // The select is controlled by the device list, which only changes once the
  // API has saved the new value; on failure it keeps showing the saved one.
  async function handleStatusChange(device: Device, next: ReverseEngineeringStatus) {
    if (next === device.reverseEngineeringStatus || savingStatusIds.has(device.deviceId)) return;

    setStatusError(null);
    setSavingStatusIds((current) => new Set(current).add(device.deviceId));
    try {
      const updated = await updateDeviceReverseEngineeringStatus(device.deviceId, next);
      if (!mountedRef.current) return;
      setDevices(
        (current) =>
          current?.map((d) =>
            d.deviceId === device.deviceId
              ? {
                  ...d,
                  reverseEngineeringStatus: updated.reverseEngineeringStatus,
                  ...(updated.updatedAt ? { updatedAt: updated.updatedAt } : {}),
                }
              : d
          ) ?? current
      );
    } catch (err) {
      if (!mountedRef.current) return;
      setStatusError(`Couldn't update ${device.name}: ${err instanceof Error ? err.message : "Failed to update status"}`);
    } finally {
      if (mountedRef.current) {
        setSavingStatusIds((current) => {
          const remaining = new Set(current);
          remaining.delete(device.deviceId);
          return remaining;
        });
      }
    }
  }

  const openDevice = (device: Device) => router.push(deviceHref(device.deviceId));

  // --- Render ---------------------------------------------------------------------
  const addButton = (
    <Button icon={Plus} onClick={() => setAdding(true)}>
      Add device
    </Button>
  );

  let body: React.ReactNode;
  if (devicesError) {
    body = (
      <ErrorState
        title="Couldn't load devices"
        message={devicesError}
        action={
          <Button variant="secondary" size="sm" onClick={() => void loadDevices()}>
            Try again
          </Button>
        }
      />
    );
  } else if (devices === null) {
    body = view === "grid" ? <DeviceGridSkeleton /> : <DeviceListSkeleton />;
  } else if (devices.length === 0) {
    body = (
      <EmptyState
        icon={Cpu}
        title={scope.kind === "workspace" ? "No devices in this workspace yet" : "No devices yet"}
        description="Register a device to start uploading its firmware and recording its vulnerabilities."
        action={addButton}
      />
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        icon={SearchX}
        title="No devices match these filters"
        description="Try a different search, or clear the filters to see every device."
        action={
          <Button variant="secondary" size="sm" onClick={() => setFilters(EMPTY_DEVICE_FILTERS)}>
            Clear filters
          </Button>
        }
      />
    );
  } else if (view === "grid") {
    body = <DeviceGridView devices={visible} figuresFor={figuresFor} urls={profileUrls} handlers={handlers} />;
  } else {
    body = (
      <DeviceListView
        devices={visible}
        figuresFor={figuresFor}
        urls={profileUrls}
        onOpen={openDevice}
        handlers={handlers}
        sort={sort}
        onSortChange={setSort}
        savingStatusIds={savingStatusIds}
        onStatusChange={(device, next) => void handleStatusChange(device, next)}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Devices"
        description="The connected medical devices under analysis"
        scope={scope}
        actions={addButton}
      />

      <DeviceSummaryCards
        progress={progress}
        loading={devices === null}
        activeStatus={filters.status}
        onSelectStatus={(status) => setFilters((current) => ({ ...current, status }))}
      />

      <Card as="section" className="overflow-hidden">
        {/* Names the region, and gives the cards' and states' h3 titles their parent heading. */}
        <h2 className="sr-only">Device list</h2>
        <DeviceToolbar
          filters={filters}
          onFiltersChange={setFilters}
          manufacturers={manufacturers}
          sort={sort}
          onSortChange={setSort}
          view={view}
          onViewChange={changeView}
          onRefresh={() => void loadDevices()}
          refreshing={devicesLoading}
        />

        {statusError && (
          <Alert tone="error" className="mx-5 mt-3" onDismiss={() => setStatusError(null)}>
            {statusError}
          </Alert>
        )}
        {cvesFailed && devices !== null && !devicesError && (
          <Alert tone="warning" className="mx-5 mt-3">
            CVE counts couldn&apos;t be loaded. Refresh to try again.
          </Alert>
        )}

        <div aria-busy={devicesLoading || undefined}>{body}</div>

        {devices !== null && devices.length > 0 && !devicesError && (
          <p className="px-5 py-3 text-xs text-slate-500 border-t border-line" aria-live="polite">
            {filtering ? `Showing ${visible.length} of ${devices.length}` : devices.length} device
            {devices.length === 1 && !filtering ? "" : "s"}
          </p>
        )}
      </Card>

      {adding && <AddDeviceDialog scope={scope} onClose={() => setAdding(false)} onCreated={loadDevices} />}
      {editing && (
        <EditDeviceDialog
          device={editing}
          onClose={() => setEditing(null)}
          onSaved={replaceDevice}
        />
      )}
      {uploadDevice && <FirmwareUploadDialog device={uploadDevice} onClose={() => setUploadDevice(null)} />}
    </div>
  );
}
