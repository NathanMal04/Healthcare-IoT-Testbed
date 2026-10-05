"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Cpu, Download, FolderArchive, Link2, Microchip, ShieldAlert, Unlink, Upload } from "lucide-react";
import { getDevices, updateDeviceReverseEngineeringStatus, type Device, type ReverseEngineeringStatus } from "@/lib/devices";
import {
  formatBytes,
  getArtifactDownloadUrl,
  listDeviceArtifacts,
  type Artifact,
} from "@/lib/artifacts";
import {
  MAX_DEVICES_PER_CVE,
  cveErrorMessage,
  isNotFound,
  linkCveDevice,
  listCves,
  unlinkCveDevice,
  type Cve,
  type CveSummary,
} from "@/lib/cves";
import { countLabel, cvesForDevice } from "@/lib/dashboard";
import { deviceHref } from "@/lib/routes";
import { useAuth } from "@/context/AuthContext";
import { useScopeLock, useWorkspace } from "@/context/WorkspaceContext";
import { isWorkspaceUnavailable, scopeKey, scopeWorkspaceId, type Scope } from "@/lib/workspaces";
import ReverseEngineeringStatusSelect from "@/app/components/ReverseEngineeringStatusSelect";
import FirmwareUploadDialog from "@/app/components/firmware/FirmwareUploadDialog";
import {
  FirmwareRetryDialog,
  FirmwareTable,
  loadDeviceFirmware,
  useFirmwareReStatus,
} from "@/app/components/firmware/FirmwareList";
import { CveDetailsDialog } from "@/app/components/CveDialogs";
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  ScopeLabel,
  SeverityBadge,
  StatusBadge,
  TabPanel,
  Tabs,
  formatDate,
  formatDay,
  selectClass,
  type Column,
} from "@/app/components/ui";

const TABS = ["overview", "firmware", "artifacts", "cves"] as const;
type TabId = (typeof TABS)[number];

export default function DeviceViewPage() {
  // useSearchParams needs a Suspense boundary under static export.
  return (
    <Suspense fallback={<LoadingState />}>
      <DeviceViewRoute />
    </Suspense>
  );
}

function DeviceViewRoute() {
  const searchParams = useSearchParams();
  const { scope, scopeReady } = useWorkspace();
  const deviceId = searchParams.get("id") ?? "";
  const tabParam = searchParams.get("tab");
  const initialTab: TabId = TABS.includes(tabParam as TabId) ? (tabParam as TabId) : "overview";

  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
  if (!deviceId) {
    return (
      <EmptyState
        icon={Cpu}
        title="No device selected"
        action={
          <ButtonLink href="/devices" variant="secondary" size="sm">
            Back to Devices
          </ButtonLink>
        }
      />
    );
  }
  // Keyed on the scope and device: switching workspace remounts the view, so
  // nothing from the previous scope carries over.
  return <DeviceView key={`${scopeKey(scope)}:${deviceId}`} deviceId={deviceId} initialTab={initialTab} />;
}

function DeviceView({ deviceId, initialTab }: { deviceId: string; initialTab: TabId }) {
  const router = useRouter();
  const { scope, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);

  const [device, setDevice] = useState<Device | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cves, setCves] = useState<CveSummary[] | null>(null);
  const [cveError, setCveError] = useState<string | null>(null);
  const [firmware, setFirmware] = useState<Artifact[] | null>(null);
  const [firmwareError, setFirmwareError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(initialTab);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // The device is looked up in the current scope's own device list: a device
  // of another scope (or one the caller can't use) is simply not there.
  useEffect(() => {
    let active = true;
    Promise.allSettled([getDevices(workspaceId), listCves(workspaceId)]).then(([deviceResult, cveResult]) => {
      if (!active) return;
      if (deviceResult.status === "fulfilled") {
        setDevices(deviceResult.value);
        const found = deviceResult.value.find((d) => d.deviceId === deviceId) ?? null;
        setDevice(found);
        setNotFound(!found);
      } else {
        setLoadError(deviceResult.reason instanceof Error ? deviceResult.reason.message : "Failed to load the device");
        if (workspaceId && isWorkspaceUnavailable(deviceResult.reason)) reportWorkspaceUnavailable();
      }
      if (cveResult.status === "fulfilled") setCves(cveResult.value);
      else setCveError(cveErrorMessage(cveResult.reason, "Couldn't load vulnerabilities"));
    });
    return () => {
      active = false;
    };
  }, [workspaceId, deviceId, reportWorkspaceUnavailable]);

  const reloadFirmware = useCallback(async () => {
    try {
      const result = await loadDeviceFirmware(deviceId);
      if (isMountedRef.current) {
        setFirmware(result);
        setFirmwareError(null);
      }
    } catch (err) {
      if (isMountedRef.current) setFirmwareError(err instanceof Error ? err.message : "Failed to load firmware");
    }
  }, [deviceId]);

  // Firmware is only requested once the device is known to be in this scope.
  useEffect(() => {
    if (device) void reloadFirmware();
  }, [device, reloadFirmware]);

  function selectTab(next: TabId) {
    setTab(next);
    router.replace(deviceHref(deviceId, next === "overview" ? undefined : next), { scroll: false });
  }

  const deviceCves = useMemo(() => cvesForDevice(cves ?? [], deviceId), [cves, deviceId]);
  const deviceNames = useMemo(() => new Map((devices ?? []).map((d) => [d.deviceId, d.name])), [devices]);

  const upsertCve = useCallback((cve: Cve) => {
    setCves((current) => current?.map((c) => (c.cveRecordId === cve.cveRecordId ? cve : c)) ?? current);
  }, []);
  const removeCve = useCallback((cveRecordId: string) => {
    setCves((current) => current?.filter((c) => c.cveRecordId !== cveRecordId) ?? current);
  }, []);

  const scopeName = scope.kind === "workspace" ? scope.name : "Personal";
  const back = { href: "/devices", label: "Devices" };

  if (loadError) {
    return (
      <>
        <PageHeader title="Device" back={back} />
        <Card>
          <ErrorState title="Couldn't load the device" message={loadError} />
        </Card>
      </>
    );
  }
  if (notFound) {
    return (
      <>
        <PageHeader title="Device not found" back={back} />
        <Card>
          <EmptyState
            icon={Cpu}
            title={`This device isn't available in ${scopeName}.`}
            description="It may belong to a different workspace or to Personal. Switch scope, or go back to this scope's devices."
            action={
              <ButtonLink href="/devices" variant="secondary" size="sm">
                Back to Devices
              </ButtonLink>
            }
          />
        </Card>
      </>
    );
  }
  if (!device) return <LoadingState label="Loading device…" />;

  return (
    <div>
      <PageHeader
        title={device.name}
        back={back}
        scope={scope}
        description="Device"
        meta={<span className="text-xs text-slate-500 capitalize">Your access: {device.role}</span>}
      />

      <Tabs
        ariaLabel="Device sections"
        active={tab}
        onChange={selectTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "firmware", label: "Firmware", count: firmware ? firmware.length : undefined },
          { id: "artifacts", label: "Artifacts" },
          { id: "cves", label: "CVEs", count: cves ? deviceCves.length : undefined },
        ]}
      />

      <TabPanel id={tab}>
        {tab === "overview" && (
          <OverviewTab
            device={device}
            scope={scope}
            firmware={firmware}
            cveCount={cves ? deviceCves.length : null}
            onDeviceChange={setDevice}
            onOpenTab={selectTab}
          />
        )}
        {tab === "firmware" && (
          <FirmwareTab
            device={device}
            firmware={firmware}
            setFirmware={setFirmware}
            error={firmwareError}
            reload={reloadFirmware}
          />
        )}
        {tab === "artifacts" && <ArtifactsTab device={device} />}
        {tab === "cves" && (
          <CvesTab
            device={device}
            scope={scope}
            allCves={cves}
            deviceCves={deviceCves}
            error={cveError}
            devices={devices}
            deviceNames={deviceNames}
            onChanged={upsertCve}
            onRemoved={removeCve}
          />
        )}
      </TabPanel>
    </div>
  );
}

// --- Overview -------------------------------------------------------------------

function OverviewTab({
  device,
  scope,
  firmware,
  cveCount,
  onDeviceChange,
  onOpenTab,
}: {
  device: Device;
  scope: Scope;
  firmware: Artifact[] | null;
  cveCount: number | null;
  onDeviceChange: (device: Device) => void;
  onOpenTab: (tab: TabId) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [artifactCount, setArtifactCount] = useState<{ count: number; hasMore: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    listDeviceArtifacts(device.deviceId, { limit: 100 })
      .then((page) => {
        if (active) setArtifactCount({ count: page.artifacts.length, hasMore: !!page.nextToken });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [device.deviceId]);

  // The select shows the saved value, which only changes once the API has
  // saved the new one; on failure it keeps showing the saved one.
  async function handleStatusChange(next: ReverseEngineeringStatus) {
    if (next === device.reverseEngineeringStatus || saving) return;
    setStatusError(null);
    setSaving(true);
    try {
      const updated = await updateDeviceReverseEngineeringStatus(device.deviceId, next);
      onDeviceChange({ ...device, reverseEngineeringStatus: updated.reverseEngineeringStatus });
    } catch (err) {
      setStatusError(`Couldn't update ${device.name}: ${err instanceof Error ? err.message : "Failed to update status"}`);
    } finally {
      setSaving(false);
    }
  }

  const facts: [string, React.ReactNode][] = [
    ["Name", device.name],
    ["Scope", <ScopeLabel key="scope" scope={scope} />],
    ["Your access", <span key="role" className="capitalize">{device.role}</span>],
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-2">
        <CardHeader title="Device information" />
        <dl className="divide-y divide-line">
          {facts.map(([label, value]) => (
            <div key={label} className="px-5 py-3 grid grid-cols-3 gap-4 text-sm">
              <dt className="text-slate-500">{label}</dt>
              <dd className="col-span-2 text-slate-900 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card>
        <CardHeader title="Reverse-engineering status" />
        <div className="p-5 space-y-3">
          <ReverseEngineeringStatusSelect
            value={device.reverseEngineeringStatus}
            saving={saving}
            onChange={(next) => void handleStatusChange(next)}
            ariaLabel={`Reverse-engineering status for ${device.name}`}
          />
          <p className="text-xs text-slate-500">Track how far the reverse engineering of this device has progressed.</p>
          {statusError && <Alert tone="error">{statusError}</Alert>}
        </div>
      </Card>

      <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <CountTile icon={Microchip} label="Firmware versions" value={firmware ? String(firmware.length) : "…"} onClick={() => onOpenTab("firmware")} />
        <CountTile
          icon={FolderArchive}
          label="Artifacts"
          value={artifactCount ? countLabel(artifactCount.count, artifactCount.hasMore) : "…"}
          onClick={() => onOpenTab("artifacts")}
        />
        <CountTile icon={ShieldAlert} label="Linked CVEs" value={cveCount === null ? "…" : String(cveCount)} onClick={() => onOpenTab("cves")} />
      </div>
    </div>
  );
}

function CountTile({
  icon: Icon,
  label,
  value,
  onClick,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left bg-white rounded-xl border border-line shadow-card p-4 hover:border-line-strong hover:shadow-md transition-shadow"
    >
      <span className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <Icon className="h-4 w-4 text-brand-600" aria-hidden="true" />
      </span>
      <span className="block text-2xl font-semibold text-slate-900 mt-2 tabular-nums">{value}</span>
    </button>
  );
}

// --- Firmware -------------------------------------------------------------------

function FirmwareTab({
  device,
  firmware,
  setFirmware,
  error,
  reload,
}: {
  device: Device;
  firmware: Artifact[] | null;
  setFirmware: React.Dispatch<React.SetStateAction<Artifact[] | null>>;
  error: string | null;
  reload: () => Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  const [retryFirmware, setRetryFirmware] = useState<Artifact | null>(null);
  const { savingReIds, reError, setReError, changeReStatus } = useFirmwareReStatus(setFirmware);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Firmware"
        description="Firmware versions uploaded for this device"
        actions={
          <Button size="sm" icon={Upload} onClick={() => setUploading(true)}>
            Upload firmware
          </Button>
        }
      />
      {reError && (
        <Alert tone="error" className="mx-5 mt-3" onDismiss={() => setReError(null)}>
          {reError}
        </Alert>
      )}
      {error ? (
        <ErrorState title="Couldn't load firmware" message={error} />
      ) : firmware === null ? (
        <LoadingState label="Loading firmware…" />
      ) : firmware.length === 0 ? (
        <EmptyState
          icon={Microchip}
          title="No firmware uploaded yet"
          action={
            <Button size="sm" icon={Upload} onClick={() => setUploading(true)}>
              Upload firmware
            </Button>
          }
        />
      ) : (
        <FirmwareTable
          firmware={firmware}
          savingReIds={savingReIds}
          onReStatusChange={(f, next) => void changeReStatus(f, next)}
          onRetry={setRetryFirmware}
        />
      )}

      {uploading && (
        <FirmwareUploadDialog device={device} onClose={() => setUploading(false)} onUploaded={() => void reload()} />
      )}
      {retryFirmware && (
        <FirmwareRetryDialog
          firmware={retryFirmware}
          onClose={() => setRetryFirmware(null)}
          onRetried={() => void reload().catch(() => undefined)}
        />
      )}
    </Card>
  );
}

// --- Artifacts ------------------------------------------------------------------

function ArtifactsTab({ device }: { device: Device }) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const loadIdRef = useRef(0);

  const load = useCallback(
    async (append: boolean, token?: string) => {
      const loadId = ++loadIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const page = await listDeviceArtifacts(device.deviceId, { limit: 100, nextToken: token });
        if (loadId !== loadIdRef.current) return;
        setArtifacts((current) => (append && current ? [...current, ...page.artifacts] : page.artifacts));
        setNextToken(page.nextToken);
      } catch (err) {
        if (loadId !== loadIdRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load artifacts");
      } finally {
        if (loadId === loadIdRef.current) setLoading(false);
      }
    },
    [device.deviceId]
  );

  useEffect(() => {
    void load(false);
    const loadIds = loadIdRef;
    return () => {
      loadIds.current++;
    };
  }, [load]);

  async function download(artifact: Artifact) {
    setDownloadError(null);
    try {
      window.location.assign(await getArtifactDownloadUrl(artifact.artifactId));
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Download failed");
    }
  }

  const columns: Column<Artifact>[] = [
    {
      key: "name",
      header: "Name",
      cell: (a) => (
        <div className="max-w-xs">
          <p className="font-medium text-slate-800 break-all">{a.name}</p>
          {a.originalFilename !== a.name && <p className="text-xs text-slate-500 break-all">{a.originalFilename}</p>}
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      className: "whitespace-nowrap text-slate-700",
      cell: (a) => (
        <>
          <span className="capitalize">{a.type}</span>
          {a.version && <span className="text-slate-400"> · {a.version}</span>}
        </>
      ),
    },
    { key: "status", header: "Status", cell: (a) => <StatusBadge status={a.status} title={a.statusReason ?? undefined} /> },
    { key: "size", header: "Size", hideBelow: "sm", className: "whitespace-nowrap text-slate-600 tabular-nums", cell: (a) => formatBytes(a.sizeBytes) },
    {
      key: "uploaded",
      header: "Uploaded",
      hideBelow: "lg",
      className: "whitespace-nowrap text-slate-500",
      cell: (a) => formatDate(a.uploadedAt ?? a.createdAt),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "text-right whitespace-nowrap",
      cell: (a) =>
        a.status === "ready" ? (
          <Button variant="ghost" size="sm" icon={Download} onClick={() => void download(a)}>
            Download
          </Button>
        ) : null,
    },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Artifacts"
        description="Every file linked to this device, including firmware"
        actions={
          <ButtonLink href="/artifacts" variant="secondary" size="sm" icon={Upload}>
            Upload on Artifacts
          </ButtonLink>
        }
      />
      {downloadError && (
        <Alert tone="error" className="mx-5 mt-3">
          Couldn&apos;t download: {downloadError}
        </Alert>
      )}
      {error ? (
        <ErrorState title="Couldn't load artifacts" message={error} />
      ) : artifacts === null ? (
        <LoadingState label="Loading artifacts…" />
      ) : artifacts.length === 0 && !nextToken ? (
        <EmptyState icon={FolderArchive} title="No files linked to this device yet" />
      ) : (
        <DataTable columns={columns} rows={artifacts} rowKey={(a) => a.artifactId} minWidth="36rem" />
      )}
      {nextToken && !error && (
        <div className="px-5 py-3 border-t border-line text-center">
          <Button variant="secondary" size="sm" onClick={() => void load(true, nextToken)} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </Card>
  );
}

// --- CVEs -----------------------------------------------------------------------

function CvesTab({
  device,
  scope,
  allCves,
  deviceCves,
  error,
  devices,
  deviceNames,
  onChanged,
  onRemoved,
}: {
  device: Device;
  scope: Scope;
  allCves: CveSummary[] | null;
  deviceCves: CveSummary[];
  error: string | null;
  devices: Device[] | null;
  deviceNames: ReadonlyMap<string, string>;
  onChanged: (cve: Cve) => void;
  onRemoved: (cveRecordId: string) => void;
}) {
  const { user } = useAuth();
  const [toLink, setToLink] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openCve, setOpenCve] = useState<CveSummary | null>(null);

  // A link change belongs to this scope; keep it from changing mid-request.
  useScopeLock(busy !== null);

  // Stable callbacks: CveDetailsDialog reloads the CVE when onGone changes.
  const closeDetails = useCallback(() => setOpenCve(null), []);
  const handleDeleted = useCallback(
    (id: string) => {
      onRemoved(id);
      setOpenCve(null);
    },
    [onRemoved]
  );
  const handleGone = useCallback(
    (id: string, message: string) => {
      onRemoved(id);
      setOpenCve(null);
      setActionError(message);
    },
    [onRemoved]
  );

  const linkable = (allCves ?? [])
    .filter((c) => !c.deviceIds.includes(device.deviceId))
    .sort((a, b) => a.cveId.localeCompare(b.cveId));

  // The existing association endpoints; "changed: false" (already linked or
  // already unlinked) counts as success.
  async function link() {
    const cveRecordId = toLink;
    if (!cveRecordId || busy) return;
    setBusy("link");
    setActionError(null);
    try {
      onChanged((await linkCveDevice(cveRecordId, device.deviceId)).cve);
      setToLink("");
    } catch (err) {
      setActionError(
        isNotFound(err)
          ? "That CVE or this device is no longer available."
          : cveErrorMessage(err, "Couldn't link the CVE")
      );
    } finally {
      setBusy(null);
    }
  }

  async function unlink(cve: CveSummary) {
    if (busy) return;
    setBusy(`unlink:${cve.cveRecordId}`);
    setActionError(null);
    try {
      onChanged((await unlinkCveDevice(cve.cveRecordId, device.deviceId)).cve);
    } catch (err) {
      if (isNotFound(err)) {
        onRemoved(cve.cveRecordId);
        setActionError(`${cve.cveId} no longer exists, or you no longer have access to it.`);
      } else {
        setActionError(cveErrorMessage(err, "Couldn't unlink the CVE"));
      }
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<CveSummary>[] = [
    {
      key: "cve",
      header: "CVE ID",
      className: "whitespace-nowrap",
      cell: (cve) => <span className="font-mono text-[13px] font-medium text-brand-700">{cve.cveId}</span>,
    },
    { key: "severity", header: "Severity", cell: (cve) => <SeverityBadge severity={cve.severity} /> },
    {
      key: "cvss",
      header: "CVSS",
      className: "whitespace-nowrap tabular-nums text-slate-700",
      cell: (cve) => (cve.cvssScore === null ? <span className="text-slate-300">—</span> : cve.cvssScore),
    },
    {
      key: "updated",
      header: "Updated",
      hideBelow: "md",
      className: "whitespace-nowrap text-slate-500",
      cell: (cve) => formatDay(cve.updatedAt),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "text-right whitespace-nowrap",
      cell: (cve) => (
        <Button
          variant="ghost"
          size="sm"
          icon={Unlink}
          disabled={busy !== null}
          onClick={(e) => {
            e.stopPropagation();
            void unlink(cve);
          }}
        >
          {busy === `unlink:${cve.cveRecordId}` ? "Unlinking…" : "Unlink"}
        </Button>
      ),
    },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Linked vulnerabilities"
        description={`CVEs recorded in ${scope.kind === "workspace" ? scope.name : "Personal"} that affect this device`}
        actions={
          <ButtonLink href="/vulnerabilities" variant="secondary" size="sm">
            All vulnerabilities
          </ButtonLink>
        }
      />
      {allCves && (
        <div className="px-5 py-3 border-b border-line flex flex-wrap items-center gap-2">
          {linkable.length ? (
            <>
              <select
                value={toLink}
                onChange={(e) => setToLink(e.target.value)}
                disabled={busy !== null}
                aria-label="CVE to link"
                className={`${selectClass} w-full sm:w-72`}
              >
                <option value="">Link a recorded CVE…</option>
                {linkable.map((cve) => (
                  <option key={cve.cveRecordId} value={cve.cveRecordId} disabled={cve.deviceIds.length >= MAX_DEVICES_PER_CVE}>
                    {cve.cveId}
                    {cve.deviceIds.length >= MAX_DEVICES_PER_CVE ? " (40 devices already)" : ""}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="secondary" icon={Link2} onClick={() => void link()} disabled={!toLink || busy !== null}>
                {busy === "link" ? "Linking…" : "Link"}
              </Button>
            </>
          ) : (
            <p className="text-xs text-slate-500">
              {allCves.length ? "Every recorded CVE is already linked to this device." : "No CVEs recorded in this scope yet."}
            </p>
          )}
        </div>
      )}
      {actionError && (
        <Alert tone="error" className="mx-5 mt-3" onDismiss={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {error ? (
        <ErrorState title="Couldn't load vulnerabilities" message={error} />
      ) : allCves === null ? (
        <LoadingState label="Loading vulnerabilities…" />
      ) : deviceCves.length === 0 ? (
        <EmptyState icon={ShieldAlert} title="No CVEs linked to this device" description="Link a recorded CVE above, or record a new one on Vulnerabilities." />
      ) : (
        <DataTable
          columns={columns}
          rows={deviceCves}
          rowKey={(cve) => cve.cveRecordId}
          onRowClick={setOpenCve}
          rowLabel={(cve) => `Open ${cve.cveId}`}
          minWidth="30rem"
        />
      )}

      {openCve && (
        <CveDetailsDialog
          key={openCve.cveRecordId}
          cveRecordId={openCve.cveRecordId}
          initial={openCve}
          scope={scope}
          devices={devices}
          deviceNames={deviceNames}
          currentUserId={user?.userId}
          onClose={closeDetails}
          onChanged={onChanged}
          onDeleted={handleDeleted}
          onGone={handleGone}
        />
      )}
    </Card>
  );
}
