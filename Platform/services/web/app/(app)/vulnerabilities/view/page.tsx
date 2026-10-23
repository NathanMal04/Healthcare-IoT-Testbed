"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronRight, Cpu, Eye, ExternalLink, FileText, Link2, Pencil, ShieldAlert, Trash2, Unlink } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useScopeLock, useWorkspace } from "@/context/WorkspaceContext";
import { getDevices, type Device } from "@/lib/devices";
import { cveHref, deviceHref } from "@/lib/routes";
import { isWorkspaceUnavailable, scopeKey, scopeWorkspaceId, type Scope } from "@/lib/workspaces";
import {
  MAX_DEVICES_PER_CVE,
  SEVERITY_LABELS,
  cveChanges,
  cveErrorMessage,
  cveFormValues,
  getCve,
  isNotFound,
  linkCveDevice,
  unlinkCveDevice,
  updateCve,
  validateCveForm,
  type Cve,
  type CveFormValues,
  type Severity,
} from "@/lib/cves";
import { CveFormFields, DeleteCveDialog, isConcurrentChange } from "@/app/components/CveDialogs";
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  ReStatusBadge,
  RowActionsMenu,
  ScopeLabel,
  SeverityBadge,
  TabPanel,
  Tabs,
  formatDate,
  formatDay,
  selectClass,
  useRequireUser,
  type Column,
} from "@/app/components/ui";

const TABS = ["description", "references", "devices"] as const;
type TabId = (typeof TABS)[number];

const UNKNOWN_DEVICE = "Unknown device";
const LINKED_DEVICES_PREVIEW = 5;
const GONE_MESSAGE = "This CVE no longer exists, or you no longer have access to it.";

const SEVERITY_BAR: Record<Severity, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-amber-500",
  low: "bg-slate-400",
};

export default function CveViewPage() {
  // useSearchParams needs a Suspense boundary under static export.
  return (
    <Suspense fallback={<LoadingState />}>
      <CveViewRoute />
    </Suspense>
  );
}

function CveViewRoute() {
  const searchParams = useSearchParams();
  const { scope, scopeReady } = useWorkspace();
  const cveRecordId = searchParams.get("id") ?? "";
  const tabParam = searchParams.get("tab");
  const initialTab: TabId = TABS.includes(tabParam as TabId) ? (tabParam as TabId) : "description";
  const initialEdit = searchParams.get("edit") === "1";

  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
  if (!cveRecordId) {
    return (
      <CveFrame>
        <Card>
          <EmptyState icon={ShieldAlert} title="No CVE selected" action={<BackToListButton />} />
        </Card>
      </CveFrame>
    );
  }
  // Keyed on the scope and CVE: switching workspace remounts the view, so
  // nothing from the previous scope carries over.
  return (
    <CveView
      key={`${scopeKey(scope)}:${cveRecordId}`}
      cveRecordId={cveRecordId}
      initialTab={initialTab}
      initialEdit={initialEdit}
    />
  );
}

function BackToListButton() {
  return (
    <ButtonLink href="/vulnerabilities" variant="secondary" size="sm">
      Back to Vulnerabilities
    </ButtonLink>
  );
}

/** Breadcrumb and back link shared by every state of the page. */
function CveFrame({ cveId, children }: { cveId?: string; children: React.ReactNode }) {
  return (
    <div>
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-slate-400">
        <span>Research</span>
        <ChevronRight className="h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
        <Link href="/vulnerabilities" className="hover:text-brand-700">
          Vulnerabilities
        </Link>
        {cveId && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
            <span className="font-mono text-slate-600" aria-current="page">
              {cveId}
            </span>
          </>
        )}
      </nav>
      <Link
        href="/vulnerabilities"
        className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700 mt-3 mb-4"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to Vulnerabilities
      </Link>
      {children}
    </div>
  );
}

function CveView({
  cveRecordId,
  initialTab,
  initialEdit,
}: {
  cveRecordId: string;
  initialTab: TabId;
  /** Opened from a row's "Edit CVE" action. */
  initialEdit: boolean;
}) {
  const ready = useRequireUser();
  const router = useRouter();
  const { user } = useAuth();
  const { scope, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);

  const [cve, setCve] = useState<Cve | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [devicesError, setDevicesError] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(initialTab);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(initialEdit);
  const [deleting, setDeleting] = useState(false);

  // A write belongs to this scope; keep it from changing mid-request.
  useScopeLock(busy !== null);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    // The CVE and the devices that name its links come from the same scope.
    Promise.allSettled([getCve(cveRecordId), getDevices(workspaceId)]).then(([cveResult, deviceResult]) => {
      if (!active) return;
      if (cveResult.status === "fulfilled") {
        setCve(cveResult.value);
      } else if (isNotFound(cveResult.reason)) {
        setGone(GONE_MESSAGE);
      } else {
        setLoadError(cveErrorMessage(cveResult.reason, "Couldn't load the CVE"));
      }
      if (deviceResult.status === "fulfilled") {
        setDevices(deviceResult.value);
      } else {
        setDevicesError(true);
        if (workspaceId && isWorkspaceUnavailable(deviceResult.reason)) reportWorkspaceUnavailable();
      }
    });
    return () => {
      active = false;
    };
  }, [ready, cveRecordId, workspaceId, reportWorkspaceUnavailable]);

  // The edit dialog opens once; drop ?edit=1 so a reload or Back doesn't reopen it.
  useEffect(() => {
    if (initialEdit) router.replace(cveHref(cveRecordId, initialTab === "description" ? undefined : initialTab), { scroll: false });
  }, [initialEdit, initialTab, cveRecordId, router]);

  const deviceNames = useMemo(() => new Map((devices ?? []).map((d) => [d.deviceId, d.name])), [devices]);
  const devicesById = useMemo(() => new Map((devices ?? []).map((d) => [d.deviceId, d])), [devices]);

  function selectTab(next: TabId) {
    setTab(next);
    router.replace(cveHref(cveRecordId, next === "description" ? undefined : next), { scroll: false });
  }

  async function stillExists(): Promise<boolean> {
    try {
      setCve(await getCve(cveRecordId));
      return true;
    } catch (err) {
      return !isNotFound(err);
    }
  }

  /**
   * Runs one write. A 404 means the CVE (or access to it) is gone, unless the
   * CVE can still be read: then it was the target (e.g. the device) that went.
   */
  async function run(label: string, action: () => Promise<void>, fallback: string, targetGone?: string) {
    setBusy(label);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      if (isNotFound(err)) {
        if (await stillExists()) setActionError(targetGone ?? cveErrorMessage(err, fallback));
        else setGone(GONE_MESSAGE);
      } else if (isConcurrentChange(err)) {
        setActionError("This CVE was changed at the same time by another request. Please try again.");
      } else {
        setActionError(cveErrorMessage(err, fallback));
      }
    } finally {
      setBusy(null);
    }
  }

  async function save(values: CveFormValues) {
    if (!cve) return;
    const changes = cveChanges(cve, values);
    if (!Object.keys(changes).length) {
      setEditing(false);
      return;
    }
    await run(
      "save",
      async () => {
        setCve(await updateCve(cveRecordId, changes));
        setEditing(false);
      },
      "Couldn't save the CVE"
    );
  }

  async function link(deviceId: string): Promise<boolean> {
    let linked = false;
    await run(
      "link",
      async () => {
        setCve((await linkCveDevice(cveRecordId, deviceId)).cve);
        linked = true;
      },
      "Couldn't link the device",
      "That device is no longer available in this scope."
    );
    return linked;
  }

  async function unlink(deviceId: string) {
    await run(
      `unlink:${deviceId}`,
      async () => setCve((await unlinkCveDevice(cveRecordId, deviceId)).cve),
      "Couldn't remove the device"
    );
  }

  if (!ready) return null;

  const scopeName = scope.kind === "workspace" ? scope.name : "Personal";

  if (gone) {
    return (
      <CveFrame>
        <Card>
          <EmptyState icon={ShieldAlert} title="CVE not available" description={gone} action={<BackToListButton />} />
        </Card>
      </CveFrame>
    );
  }
  if (loadError) {
    return (
      <CveFrame>
        <Card>
          <ErrorState title="Couldn't load the CVE" message={loadError} action={<BackToListButton />} />
        </Card>
      </CveFrame>
    );
  }
  if (!cve) return <LoadingState label="Loading CVE…" />;

  // A CVE of another scope (e.g. after switching workspace) isn't shown here,
  // the same way the list only shows the current scope's CVEs.
  if ((cve.workspaceId ?? null) !== (workspaceId ?? null)) {
    return (
      <CveFrame cveId={cve.cveId}>
        <Card>
          <EmptyState
            icon={ShieldAlert}
            title={`This CVE isn't recorded in ${scopeName}.`}
            description="It belongs to a different workspace or to Personal. Switch scope, or go back to this scope's vulnerabilities."
            action={<BackToListButton />}
          />
        </Card>
      </CveFrame>
    );
  }

  const deviceCount = cve.deviceIds.length;
  const createdBy = user?.userId && cve.createdBy === user.userId ? "by you" : "by another member";
  const openEdit = () => {
    setActionError(null);
    setEditing(true);
  };

  return (
    <CveFrame cveId={cve.cveId}>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="min-w-0 flex-1">
          <h1 className="font-mono text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight break-words">
            {cve.cveId}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <SeverityBadge severity={cve.severity} />
            <span className="text-slate-500">
              CVSS{" "}
              <span className="font-semibold text-slate-900 tabular-nums">{cve.cvssScore ?? "—"}</span>
              {cve.cvssVersion && <span className="text-xs text-slate-400 ml-1">v{cve.cvssVersion}</span>}
            </span>
            <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
              ·
            </span>
            <ScopeLabel scope={scope} />
          </div>
          {cve.description && (
            <p className="mt-3 max-w-3xl text-sm text-slate-600 line-clamp-3 whitespace-pre-wrap break-words">
              {cve.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={Pencil} onClick={openEdit} disabled={busy !== null}>
            Edit
          </Button>
          <RowActionsMenu
            trigger="button"
            label={`More actions for ${cve.cveId}`}
            disabled={busy !== null}
            actions={[
              {
                label: "Delete CVE",
                icon: Trash2,
                danger: true,
                onSelect: () => {
                  setActionError(null);
                  setDeleting(true);
                },
              },
            ]}
          />
        </div>
      </div>

      {actionError && !editing && !deleting && (
        <Alert tone="error" onDismiss={() => setActionError(null)} className="mb-4">
          {actionError}
        </Alert>
      )}
      {devicesError && (
        <Alert tone="warning" className="mb-4">
          Devices couldn&apos;t be loaded. Linked devices are shown as &quot;{UNKNOWN_DEVICE}&quot;.
        </Alert>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
        <KeyInformation cve={cve} scope={scope} createdBy={createdBy} />
        <Card className="flex flex-col">
          <CardHeader
            title="Affected chipsets"
            description={cve.affectedChipsets.length ? `${cve.affectedChipsets.length} recorded` : undefined}
          />
          <div className="p-5 flex-1">
            {cve.affectedChipsets.length ? (
              <div className="flex flex-wrap gap-1.5">
                {cve.affectedChipsets.map((chipset) => (
                  <span
                    key={chipset}
                    className="font-mono text-xs px-2 py-1 rounded-md bg-surface-sunken text-slate-700 ring-1 ring-inset ring-line"
                  >
                    {chipset}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-400">No chipsets recorded.</p>
            )}
          </div>
        </Card>
        <Card className="flex flex-col md:col-span-2 xl:col-span-1">
          <CardHeader
            title="Linked devices"
            description={`${deviceCount} of ${MAX_DEVICES_PER_CVE}`}
            actions={
              <Button variant="link" size="sm" onClick={() => selectTab("devices")}>
                {deviceCount ? "Manage" : "Link a device"}
              </Button>
            }
          />
          <div className="p-5 flex-1">
            {deviceCount ? (
              <ul className="space-y-2">
                {sortedDeviceIds(cve.deviceIds, deviceNames)
                  .slice(0, LINKED_DEVICES_PREVIEW)
                  .map((id) => (
                    <li key={id} className="flex items-center gap-2 text-sm min-w-0">
                      <Cpu className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                      <DeviceName id={id} names={deviceNames} />
                    </li>
                  ))}
                {deviceCount > LINKED_DEVICES_PREVIEW && (
                  <li>
                    <button
                      type="button"
                      onClick={() => selectTab("devices")}
                      className="text-xs font-medium text-brand-600 hover:text-brand-700"
                    >
                      +{deviceCount - LINKED_DEVICES_PREVIEW} more
                    </button>
                  </li>
                )}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">No devices linked yet.</p>
            )}
          </div>
        </Card>
      </div>

      <Tabs
        ariaLabel="CVE sections"
        active={tab}
        onChange={selectTab}
        tabs={[
          { id: "description", label: "Description" },
          { id: "references", label: "References", count: cve.references.length },
          { id: "devices", label: "Linked devices", count: deviceCount },
        ]}
      />

      <TabPanel id={tab}>
        {tab === "description" && (
          <Card>
            <CardHeader title="Description" />
            {cve.description ? (
              <p className="p-5 text-sm leading-relaxed text-slate-700 whitespace-pre-wrap break-words">{cve.description}</p>
            ) : (
              <EmptyState
                icon={FileText}
                title="No description recorded"
                action={
                  <Button variant="secondary" size="sm" icon={Pencil} onClick={openEdit}>
                    Add a description
                  </Button>
                }
              />
            )}
          </Card>
        )}
        {tab === "references" && (
          <Card className="overflow-hidden">
            <CardHeader title="References" description="Advisories, write-ups and other sources for this CVE" />
            {cve.references.length ? (
              <ul className="divide-y divide-line">
                {cve.references.map((reference) => (
                  <li key={reference}>
                    <a
                      href={reference}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-start gap-3 px-5 py-3 hover:bg-surface-muted"
                    >
                      <ExternalLink className="h-4 w-4 mt-0.5 shrink-0 text-slate-400 group-hover:text-brand-600" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800 group-hover:text-brand-700">
                          {hostname(reference)}
                        </span>
                        <span className="block text-xs text-slate-500 break-all">{reference}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={Link2}
                title="No references recorded"
                action={
                  <Button variant="secondary" size="sm" icon={Pencil} onClick={openEdit}>
                    Add references
                  </Button>
                }
              />
            )}
          </Card>
        )}
        {tab === "devices" && (
          <LinkedDevicesTab
            cve={cve}
            scopeName={scopeName}
            devices={devices}
            devicesById={devicesById}
            deviceNames={deviceNames}
            busy={busy}
            onLink={link}
            onUnlink={(id) => void unlink(id)}
          />
        )}
      </TabPanel>

      {editing && (
        <EditCveDialog
          cve={cve}
          saving={busy === "save"}
          error={actionError}
          onCancel={() => {
            setActionError(null);
            setEditing(false);
          }}
          onSave={(values) => void save(values)}
        />
      )}

      {deleting && (
        <DeleteCveDialog
          cve={cve}
          scope={scope}
          onCancel={() => setDeleting(false)}
          onDeleted={() => router.push("/vulnerabilities")}
          onGone={(_, message) => {
            setDeleting(false);
            setGone(message);
          }}
          onRefreshed={setCve}
        />
      )}
    </CveFrame>
  );
}

// --- Summary --------------------------------------------------------------------

function KeyInformation({ cve, scope, createdBy }: { cve: Cve; scope: Scope; createdBy: string }) {
  const facts: [string, React.ReactNode][] = [
    ["CVE ID", <span key="id" className="font-mono">{cve.cveId}</span>],
    ["Severity", SEVERITY_LABELS[cve.severity]],
    ["CVSS score", <CvssScore key="cvss" cve={cve} />],
    ["Scope", <ScopeLabel key="scope" scope={scope} />],
    [
      "Created",
      <span key="created" title={formatDate(cve.createdAt)}>
        {formatDay(cve.createdAt)} <span className="text-slate-400">{createdBy}</span>
      </span>,
    ],
    ["Last updated", <span key="updated" title={formatDate(cve.updatedAt)}>{formatDay(cve.updatedAt)}</span>],
  ];
  return (
    <Card>
      <CardHeader title="Key information" />
      <dl className="divide-y divide-line">
        {facts.map(([label, value]) => (
          <div key={label} className="px-5 py-2.5 grid grid-cols-5 gap-3 text-sm">
            <dt className="col-span-2 text-slate-500">{label}</dt>
            <dd className="col-span-3 text-slate-900 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function CvssScore({ cve }: { cve: Cve }) {
  if (cve.cvssScore === null) return <span className="text-slate-400">Not scored</span>;
  return (
    <span className="block">
      <span className="tabular-nums font-medium">{cve.cvssScore}</span>
      <span className="text-slate-400"> / 10</span>
      {cve.cvssVersion && <span className="text-xs text-slate-400 ml-1.5">CVSS v{cve.cvssVersion}</span>}
      <span className="block mt-1.5 h-1.5 w-full max-w-[8rem] rounded-full bg-surface-sunken overflow-hidden" aria-hidden="true">
        <span className={`block h-full rounded-full ${SEVERITY_BAR[cve.severity]}`} style={{ width: `${cve.cvssScore * 10}%` }} />
      </span>
    </span>
  );
}

function sortedDeviceIds(ids: string[], names: ReadonlyMap<string, string>): string[] {
  const name = (id: string) => names.get(id) ?? UNKNOWN_DEVICE;
  return [...ids].sort((a, b) => name(a).localeCompare(name(b)));
}

/** A linked device's name, linking to its page when it's a device of this scope. */
function DeviceName({ id, names }: { id: string; names: ReadonlyMap<string, string> }) {
  const name = names.get(id);
  if (!name) return <span className="text-slate-400 italic truncate">{UNKNOWN_DEVICE}</span>;
  return (
    <Link href={deviceHref(id)} className="font-medium text-slate-800 hover:text-brand-700 hover:underline truncate">
      {name}
    </Link>
  );
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// --- Actions --------------------------------------------------------------------

function EditCveDialog({
  cve,
  saving,
  error,
  onCancel,
  onSave,
}: {
  cve: Cve;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (values: CveFormValues) => void;
}) {
  const [values, setValues] = useState<CveFormValues>(() => cveFormValues(cve));
  const [showErrors, setShowErrors] = useState(false);
  const errors = useMemo(() => validateCveForm(values, { mode: "edit" }), [values]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length) return;
    onSave(values);
  }

  return (
    <Dialog title={`Edit ${cve.cveId}`} size="xl" onClose={() => !saving && onCancel()}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <CveFormFields values={values} onChange={setValues} errors={showErrors ? errors : {}} mode="edit" disabled={saving} />
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// --- Linked devices -------------------------------------------------------------

interface LinkedRow {
  id: string;
  device?: Device;
}

function LinkedDevicesTab({
  cve,
  scopeName,
  devices,
  devicesById,
  deviceNames,
  busy,
  onLink,
  onUnlink,
}: {
  cve: Cve;
  scopeName: string;
  devices: Device[] | null;
  devicesById: ReadonlyMap<string, Device>;
  deviceNames: ReadonlyMap<string, string>;
  busy: string | null;
  onLink: (deviceId: string) => Promise<boolean>;
  onUnlink: (deviceId: string) => void;
}) {
  const [toLink, setToLink] = useState("");
  const linkedIds = cve.deviceIds;
  const atLimit = linkedIds.length >= MAX_DEVICES_PER_CVE;
  const linkable = (devices ?? [])
    .filter((d) => !linkedIds.includes(d.deviceId))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rows: LinkedRow[] = sortedDeviceIds(linkedIds, deviceNames).map((id) => ({ id, device: devicesById.get(id) }));

  async function link() {
    if (!toLink || busy) return;
    if (await onLink(toLink)) setToLink("");
  }

  const columns: Column<LinkedRow>[] = [
    {
      key: "device",
      header: "Device",
      cell: (row) => (
        <span className="flex items-center gap-2 min-w-0">
          <Cpu className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          <DeviceName id={row.id} names={deviceNames} />
        </span>
      ),
    },
    {
      key: "re",
      header: "Reverse engineering",
      hideBelow: "sm",
      cell: (row) => (row.device ? <ReStatusBadge status={row.device.reverseEngineeringStatus} /> : <span className="text-slate-300">—</span>),
    },
    {
      key: "actions",
      header: "Actions",
      headerClassName: "text-right",
      className: "text-right whitespace-nowrap",
      cell: (row) =>
        busy === `unlink:${row.id}` ? (
          <span className="text-xs text-slate-500">Unlinking…</span>
        ) : (
          <RowActionsMenu
            label={`Actions for ${row.device?.name ?? UNKNOWN_DEVICE}`}
            disabled={busy !== null}
            actions={[
              row.device && { label: "View device", icon: Eye, href: deviceHref(row.id) },
              { label: "Unlink from CVE", icon: Unlink, onSelect: () => onUnlink(row.id) },
            ]}
          />
        ),
    },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Linked devices"
        description={`Devices in ${scopeName} affected by this CVE · ${linkedIds.length} of ${MAX_DEVICES_PER_CVE}`}
      />
      <div className="px-5 py-3 border-b border-line flex flex-wrap items-center gap-2">
        {devices === null ? (
          <p className="text-xs text-slate-500">Devices couldn&apos;t be loaded, so none can be linked right now.</p>
        ) : atLimit ? (
          <p className="text-xs text-slate-500">A CVE can be linked to at most {MAX_DEVICES_PER_CVE} devices.</p>
        ) : linkable.length === 0 ? (
          <p className="text-xs text-slate-500">
            {devices.length ? "Every device in this scope is already linked." : "No devices in this scope yet."}
          </p>
        ) : (
          <>
            <select
              value={toLink}
              onChange={(e) => setToLink(e.target.value)}
              disabled={busy !== null}
              aria-label="Device to link"
              className={`${selectClass} w-full sm:w-72`}
            >
              <option value="">Link a device…</option>
              {linkable.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.name}
                </option>
              ))}
            </select>
            <Button size="sm" variant="secondary" icon={Link2} onClick={() => void link()} disabled={!toLink || busy !== null}>
              {busy === "link" ? "Linking…" : "Link"}
            </Button>
          </>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={Cpu}
          title="No devices linked"
          description="Link the devices this vulnerability affects to track them together."
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} minWidth="22rem" />
      )}
    </Card>
  );
}
