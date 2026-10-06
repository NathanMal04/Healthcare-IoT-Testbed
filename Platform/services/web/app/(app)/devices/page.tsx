"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Cpu, Eye, Microchip, Plus, RefreshCw, ShieldAlert, Upload } from "lucide-react";
import { getDevices, updateDeviceReverseEngineeringStatus, type Device, type ReverseEngineeringStatus } from "@/lib/devices";
import { REVERSE_ENGINEERING_STATUSES, REVERSE_ENGINEERING_STATUS_LABELS } from "@/lib/reverseEngineering";
import { filterDevices } from "@/lib/dashboard";
import { deviceHref } from "@/lib/routes";
import { useWorkspace } from "@/context/WorkspaceContext";
import { isWorkspaceUnavailable, scopeKey, scopeWorkspaceId } from "@/lib/workspaces";
import ReverseEngineeringStatusSelect from "@/app/components/ReverseEngineeringStatusSelect";
import AddDeviceDialog from "@/app/components/AddDeviceDialog";
import FirmwareUploadDialog from "@/app/components/firmware/FirmwareUploadDialog";
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
  Toolbar,
  type Column,
} from "@/app/components/ui";

export default function DevicesPage() {
  const { scope, scopeReady } = useWorkspace();
  // Until the saved workspace is restored, nothing scoped mounts, so no
  // Personal requests go out first.
  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
  // Keyed on the scope: switching remounts the view, so no devices, errors or
  // dialogs carry over, and a late response for the previous scope lands in
  // the unmounted view instead of this one.
  return <DevicesView key={scopeKey(scope)} />;
}

function DevicesView() {
  const router = useRouter();
  const { scope, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);

  const [devices, setDevices] = useState<Device[] | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [reFilter, setReFilter] = useState<ReverseEngineeringStatus | "">("");
  const [adding, setAdding] = useState(false);
  const [uploadDevice, setUploadDevice] = useState<Device | null>(null);

  const [savingStatusIds, setSavingStatusIds] = useState<Set<string>>(new Set());
  const [statusError, setStatusError] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Only the latest load may update the list (e.g. a reload after creating a
  // device overtaking the first one).
  const loadIdRef = useRef(0);

  const loadDevices = useCallback(async () => {
    if (!isMountedRef.current) return;
    const loadId = ++loadIdRef.current;
    const isCurrent = () => isMountedRef.current && loadId === loadIdRef.current;
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const result = await getDevices(workspaceId);
      if (isCurrent()) setDevices(result);
    } catch (err) {
      if (isCurrent()) {
        setDevicesError(err instanceof Error ? err.message : "Failed to load devices");
        if (workspaceId && isWorkspaceUnavailable(err)) reportWorkspaceUnavailable();
      }
    } finally {
      if (isCurrent()) setDevicesLoading(false);
    }
  }, [workspaceId, reportWorkspaceUnavailable]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  // The select is controlled by the device list, which only changes once the
  // API has saved the new value; on failure it keeps showing the saved one.
  async function handleStatusChange(device: Device, next: ReverseEngineeringStatus) {
    if (next === device.reverseEngineeringStatus || savingStatusIds.has(device.deviceId)) return;

    setStatusError(null);
    setSavingStatusIds((current) => new Set(current).add(device.deviceId));
    try {
      const updated = await updateDeviceReverseEngineeringStatus(device.deviceId, next);
      if (!isMountedRef.current) return;
      setDevices(
        (current) =>
          current?.map((d) =>
            d.deviceId === device.deviceId ? { ...d, reverseEngineeringStatus: updated.reverseEngineeringStatus } : d
          ) ?? current
      );
    } catch (err) {
      if (!isMountedRef.current) return;
      setStatusError(`Couldn't update ${device.name}: ${err instanceof Error ? err.message : "Failed to update status"}`);
    } finally {
      if (isMountedRef.current) {
        setSavingStatusIds((current) => {
          const remaining = new Set(current);
          remaining.delete(device.deviceId);
          return remaining;
        });
      }
    }
  }

  const visible = useMemo(
    () => filterDevices([...(devices ?? [])].sort((a, b) => a.name.localeCompare(b.name)), query, reFilter),
    [devices, query, reFilter]
  );
  const filtering = query.trim() !== "" || reFilter !== "";

  const columns: Column<Device>[] = [
    {
      key: "name",
      header: "Device",
      cell: (device) => (
        <div className="flex items-center gap-3 min-w-0">
          <span className="h-8 w-8 shrink-0 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
            <Cpu className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="font-medium text-slate-900 break-words">{device.name}</span>
        </div>
      ),
    },
    {
      key: "access",
      header: "Your access",
      hideBelow: "sm",
      className: "text-slate-600 capitalize whitespace-nowrap",
      cell: (device) => device.role,
    },
    {
      key: "re",
      header: "Reverse engineering",
      className: "whitespace-nowrap",
      cell: (device) => (
        <div onClick={(e) => e.stopPropagation()}>
          <ReverseEngineeringStatusSelect
            value={device.reverseEngineeringStatus}
            saving={savingStatusIds.has(device.deviceId)}
            onChange={(next) => void handleStatusChange(device, next)}
            ariaLabel={`Reverse-engineering status for ${device.name}`}
          />
        </div>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      headerClassName: "text-right",
      className: "text-right",
      cell: (device) => (
        <RowActionsMenu
          label={`Actions for ${device.name}`}
          actions={[
            { label: "View details", icon: Eye, href: deviceHref(device.deviceId) },
            { label: "View firmware", icon: Microchip, href: deviceHref(device.deviceId, "firmware") },
            { label: "View CVEs", icon: ShieldAlert, href: deviceHref(device.deviceId, "cves") },
            { label: "Upload firmware", icon: Upload, onSelect: () => setUploadDevice(device) },
          ]}
        />
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Devices"
        description="The connected medical devices under analysis"
        scope={scope}
        actions={
          <Button icon={Plus} onClick={() => setAdding(true)}>
            Add device
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <Toolbar>
          <SearchInput value={query} onChange={setQuery} placeholder="Search devices by name" ariaLabel="Search devices" />
          <FilterSelect
            value={reFilter}
            onChange={(value) => setReFilter(value as ReverseEngineeringStatus | "")}
            ariaLabel="Reverse-engineering status"
          >
            <option value="">All RE statuses</option>
            {REVERSE_ENGINEERING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {REVERSE_ENGINEERING_STATUS_LABELS[status]}
              </option>
            ))}
          </FilterSelect>
          {filtering && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery("");
                setReFilter("");
              }}
            >
              Clear filters
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={RefreshCw}
            onClick={() => void loadDevices()}
            disabled={devicesLoading}
            className="ml-auto"
          >
            Refresh
          </Button>
        </Toolbar>

        {statusError && (
          <Alert tone="error" className="mx-5 mt-3" onDismiss={() => setStatusError(null)}>
            {statusError}
          </Alert>
        )}

        {devicesError ? (
          <ErrorState title="Couldn't load devices" message={devicesError} />
        ) : devices === null ? (
          <LoadingState label="Loading devices…" />
        ) : devices.length === 0 ? (
          <EmptyState
            icon={Cpu}
            title={scope.kind === "workspace" ? "No devices in this workspace yet" : "No devices yet"}
            description="Register a device to start uploading its firmware and recording its vulnerabilities."
            action={
              <Button icon={Plus} onClick={() => setAdding(true)}>
                Add device
              </Button>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState icon={Cpu} title="No devices match these filters" />
        ) : (
          <DataTable
            columns={columns}
            rows={visible}
            rowKey={(d) => d.deviceId}
            onRowClick={(device) => router.push(deviceHref(device.deviceId))}
            rowLabel={(device) => `Open ${device.name}`}
            minWidth="34rem"
          />
        )}

        {devices !== null && devices.length > 0 && !devicesError && (
          <p className="px-5 py-3 text-xs text-slate-500 border-t border-line">
            {filtering ? `Showing ${visible.length} of ${devices.length}` : devices.length} device
            {devices.length === 1 && !filtering ? "" : "s"}
          </p>
        )}
      </Card>

      {adding && <AddDeviceDialog scope={scope} onClose={() => setAdding(false)} onCreated={loadDevices} />}
      {uploadDevice && <FirmwareUploadDialog device={uploadDevice} onClose={() => setUploadDevice(null)} />}
    </div>
  );
}
