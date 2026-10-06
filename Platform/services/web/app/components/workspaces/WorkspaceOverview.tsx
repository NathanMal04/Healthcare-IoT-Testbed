"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, ChevronRight, Cpu, Microchip, ShieldAlert, UserPlus, Users, type LucideIcon } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useWorkspace } from "@/context/WorkspaceContext";
import type { Workspace } from "@/lib/workspaces";
import type { Device } from "@/lib/devices";
import type { Artifact } from "@/lib/artifacts";
import type { CveSummary } from "@/lib/cves";
import { cveHref, deviceHref } from "@/lib/routes";
import { firmwareReverseEngineeringStatus } from "@/lib/artifacts";
import {
  InviteMemberForm,
  MembersTable,
  PendingInvitesTable,
  RoleBadge,
  useWorkspaceDetail,
} from "@/app/components/WorkspaceDialogs";
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  LoadingState,
  ReStatusBadge,
  SeverityBadge,
  StatusBadge,
  TabPanel,
  Tabs,
  formatDate,
  formatDay,
  type Column,
  type TabItem,
} from "@/app/components/ui";
import { CountRow, KIND_STYLES, KindTile, SelectedPill, scopeCounts } from "./parts";
import { firmwareCount, type ScopeResources } from "./useWorkspaceResources";

type TabId = "members" | "invitations" | "devices" | "firmware" | "cves";

const LOCKED_TITLE = "Finish the upload or change in progress before switching";

/**
 * One workspace: its header and tabs. Members and invitations come from the
 * existing GET /workspaces/{id} (with invite for owners); devices, firmware
 * and CVEs are the read-only lists the page already loaded. Opening an item
 * needs the workspace to be selected, since those pages show the selected
 * scope.
 */
export function WorkspaceOverview({
  workspace,
  resources,
  onBack,
}: {
  workspace: Workspace;
  resources: ScopeResources | undefined;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const { scope, selectWorkspace, scopeLocked } = useWorkspace();
  const { detail, error, invite } = useWorkspaceDetail(workspace.workspaceId);
  const [tab, setTab] = useState<TabId>("members");
  const [inviting, setInviting] = useState(false);

  const selected = scope.kind === "workspace" && scope.workspaceId === workspace.workspaceId;
  const isOwner = (detail?.workspace.role ?? workspace.role) === "owner";
  const members = detail?.members ?? resources?.members;
  const length = (list: unknown[] | null | undefined) => (list ? list.length : undefined);

  const tabs: TabItem<TabId>[] = [
    { id: "members", label: "Members", count: length(members) },
    // Pending invitations are only returned to owners.
    ...(isOwner ? [{ id: "invitations" as const, label: "Invitations", count: length(detail?.invites) }] : []),
    { id: "devices", label: "Devices", count: length(resources?.devices) },
    {
      id: "firmware",
      label: "Firmware",
      count: resources?.firmware ? firmwareCount(resources.firmware) ?? undefined : undefined,
    },
    { id: "cves", label: "CVE entries", count: length(resources?.cves) },
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "members";

  const switchNotice = !selected && (
    <Alert
      tone="info"
      className="mb-4"
      action={
        <Button
          size="sm"
          variant="secondary"
          icon={ArrowRightLeft}
          onClick={() => selectWorkspace(workspace)}
          disabled={scopeLocked}
          title={scopeLocked ? LOCKED_TITLE : undefined}
        >
          Switch
        </Button>
      }
    >
      Switch to {workspace.name} to open these items and make changes.
    </Alert>
  );

  return (
    <div className="space-y-5">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs font-medium text-slate-500">
        <button type="button" onClick={onBack} className="hover:text-brand-700">
          Workspaces
        </button>
        <ChevronRight className="h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
        <span className="text-slate-800 truncate">{workspace.name}</span>
      </nav>

      <Card className="overflow-hidden">
        <div className={`h-16 border-b ${KIND_STYLES[workspace.role].band}`} aria-hidden="true" />
        <div className="px-5 pb-5 -mt-7 flex flex-col sm:flex-row sm:items-end gap-4">
          <KindTile kind={workspace.role} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight break-words">{workspace.name}</h1>
              <RoleBadge role={workspace.role} />
              {selected && <SelectedPill />}
            </div>
            <p className="text-sm text-slate-500 mt-1">
              {isOwner ? "You own this workspace and can invite members." : "You are a member of this workspace."} Created{" "}
              {formatDay(workspace.createdAt)}.
            </p>
          </div>
          {!selected && (
            <Button
              icon={ArrowRightLeft}
              onClick={() => selectWorkspace(workspace)}
              disabled={scopeLocked}
              title={scopeLocked ? LOCKED_TITLE : undefined}
            >
              Switch to workspace
            </Button>
          )}
        </div>
        <div className="px-5 py-3 border-t border-line bg-surface-muted/60">
          <CountRow counts={scopeCounts(resources, true)} />
        </div>
      </Card>

      <div>
        <Tabs tabs={tabs} active={activeTab} onChange={setTab} ariaLabel="Workspace sections" />

        {activeTab === "members" && (
          <TabPanel id="members">
            <Card>
              <div className="px-5 py-4 border-b border-line flex flex-wrap items-center gap-3">
                <div className="min-w-0 mr-auto">
                  <h2 className="text-sm font-semibold text-slate-800">
                    Members{detail ? ` (${detail.members.length})` : ""}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {isOwner ? "People with access to this workspace." : "Only workspace owners can invite members."}
                  </p>
                </div>
                {isOwner && detail && (
                  <Button icon={UserPlus} onClick={() => setInviting(true)}>
                    Invite member
                  </Button>
                )}
              </div>
              <div className="p-5">
                {error && <Alert tone="error" className="mb-4">{error}</Alert>}
                {detail ? (
                  detail.members.length > 0 ? (
                    <MembersTable members={detail.members} currentUserId={user?.userId ?? null} />
                  ) : (
                    <EmptyState icon={Users} title="No members yet" className="py-8" />
                  )
                ) : (
                  !error && <LoadingState />
                )}
              </div>
            </Card>
          </TabPanel>
        )}

        {activeTab === "invitations" && (
          <TabPanel id="invitations">
            <Card>
              <div className="px-5 py-4 border-b border-line flex flex-wrap items-center gap-3">
                <div className="min-w-0 mr-auto">
                  <h2 className="text-sm font-semibold text-slate-800">Pending invitations</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Invitations waiting to be accepted or declined.</p>
                </div>
                {detail && (
                  <Button variant="secondary" icon={UserPlus} onClick={() => setInviting(true)}>
                    Invite member
                  </Button>
                )}
              </div>
              <div className="p-5">
                {error && <Alert tone="error" className="mb-4">{error}</Alert>}
                {detail ? <PendingInvitesTable detail={detail} /> : !error && <LoadingState />}
              </div>
            </Card>
          </TabPanel>
        )}

        {activeTab === "devices" && (
          <TabPanel id="devices">
            {switchNotice}
            <ResourceCard
              title="Devices"
              list={resources?.devices}
              empty={{ icon: Cpu, title: "No devices in this workspace" }}
              link={selected ? { href: "/devices", label: "Open Devices" } : undefined}
            >
              {(devices) => <DevicesTable devices={devices} openable={selected} />}
            </ResourceCard>
          </TabPanel>
        )}

        {activeTab === "firmware" && (
          <TabPanel id="firmware">
            {switchNotice}
            <ResourceCard
              title="Firmware"
              note={resources?.firmware?.hasMore ? "Showing the latest 100 firmware files." : undefined}
              list={resources?.firmware === undefined ? undefined : resources.firmware?.items ?? null}
              empty={{ icon: Microchip, title: "No firmware in this workspace" }}
              link={selected ? { href: "/firmware", label: "Open Firmware" } : undefined}
            >
              {(firmware) => <FirmwareTable firmware={firmware} />}
            </ResourceCard>
          </TabPanel>
        )}

        {activeTab === "cves" && (
          <TabPanel id="cves">
            {switchNotice}
            <ResourceCard
              title="CVE entries"
              list={resources?.cves}
              empty={{ icon: ShieldAlert, title: "No CVE entries in this workspace" }}
              link={selected ? { href: "/vulnerabilities", label: "Open Vulnerabilities" } : undefined}
            >
              {(cves) => <CvesTable cves={cves} openable={selected} />}
            </ResourceCard>
          </TabPanel>
        )}
      </div>

      {inviting && detail && (
        <Dialog title="Invite a member" subtitle={`They'll join ${workspace.name} as a member`} onClose={() => setInviting(false)} wide>
          <InviteMemberForm onInvite={invite} />
        </Dialog>
      )}
    </div>
  );
}

function ResourceCard<T>({
  title,
  note,
  list,
  empty,
  link,
  children,
}: {
  title: string;
  note?: string;
  list: T[] | null | undefined;
  empty: { icon: LucideIcon; title: string };
  link?: { href: string; label: string };
  children: (items: T[]) => React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-4 border-b border-line flex flex-wrap items-center gap-3">
        <div className="min-w-0 mr-auto">
          <h2 className="text-sm font-semibold text-slate-800">
            {title}
            {list ? ` (${list.length})` : ""}
          </h2>
          {note && <p className="text-xs text-slate-500 mt-0.5">{note}</p>}
        </div>
        {link && (
          <ButtonLink href={link.href} size="sm">
            {link.label}
          </ButtonLink>
        )}
      </div>
      {list === undefined ? (
        <LoadingState />
      ) : list === null ? (
        <div className="p-5">
          <Alert tone="error">Couldn&apos;t load {title.toLowerCase()}. Please try again later.</Alert>
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon={empty.icon} title={empty.title} className="py-10" />
      ) : (
        children(list)
      )}
    </Card>
  );
}

function DevicesTable({ devices, openable }: { devices: Device[]; openable: boolean }) {
  const router = useRouter();
  const columns: Column<Device>[] = [
    { key: "name", header: "Device", cell: (d) => <span className="font-medium text-slate-900">{d.name}</span> },
    { key: "re", header: "Reverse engineering", cell: (d) => <ReStatusBadge status={d.reverseEngineeringStatus} /> },
  ];
  return (
    <DataTable
      columns={columns}
      rows={devices}
      rowKey={(d) => d.deviceId}
      onRowClick={openable ? (d) => router.push(deviceHref(d.deviceId)) : undefined}
      rowLabel={(d) => `Open ${d.name}`}
      minWidth="24rem"
    />
  );
}

function FirmwareTable({ firmware }: { firmware: Artifact[] }) {
  const columns: Column<Artifact>[] = [
    {
      key: "name",
      header: "Firmware",
      cell: (a) => (
        <div className="min-w-0">
          <p className="font-medium text-slate-900 truncate">{a.name}</p>
          {a.version && <p className="text-xs text-slate-500">Version {a.version}</p>}
        </div>
      ),
    },
    { key: "status", header: "Upload", cell: (a) => <StatusBadge status={a.status} /> },
    {
      key: "re",
      header: "Reverse engineering",
      cell: (a) => <ReStatusBadge status={firmwareReverseEngineeringStatus(a)} />,
      hideBelow: "md",
    },
    {
      key: "created",
      header: "Uploaded",
      cell: (a) => <span className="text-slate-600">{formatDate(a.uploadedAt ?? a.createdAt)}</span>,
      hideBelow: "sm",
      className: "whitespace-nowrap",
    },
  ];
  return <DataTable columns={columns} rows={firmware} rowKey={(a) => a.artifactId} minWidth="32rem" />;
}

function CvesTable({ cves, openable }: { cves: CveSummary[]; openable: boolean }) {
  const router = useRouter();
  const columns: Column<CveSummary>[] = [
    { key: "id", header: "CVE", cell: (c) => <span className="font-medium text-slate-900 font-mono text-xs">{c.cveId}</span> },
    { key: "severity", header: "Severity", cell: (c) => <SeverityBadge severity={c.severity} /> },
    {
      key: "cvss",
      header: "CVSS",
      cell: (c) => <span className="tabular-nums text-slate-700">{c.cvssScore ?? "—"}</span>,
      hideBelow: "sm",
    },
    {
      key: "devices",
      header: "Devices",
      cell: (c) => <span className="tabular-nums text-slate-700">{c.deviceIds.length}</span>,
      hideBelow: "md",
    },
    {
      key: "updated",
      header: "Updated",
      cell: (c) => <span className="text-slate-600">{formatDay(c.updatedAt)}</span>,
      hideBelow: "sm",
      className: "whitespace-nowrap",
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={cves}
      rowKey={(c) => c.cveRecordId}
      onRowClick={openable ? (c) => router.push(cveHref(c.cveRecordId)) : undefined}
      rowLabel={(c) => `Open ${c.cveId}`}
      minWidth="32rem"
    />
  );
}
