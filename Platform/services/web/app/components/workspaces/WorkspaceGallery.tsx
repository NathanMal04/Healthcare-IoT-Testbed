"use client";

import { ArrowRightLeft, Building2, Eye, FolderOpen, Plus, ShieldCheck, UserPlus, UserRound } from "lucide-react";
import { useWorkspace } from "@/context/WorkspaceContext";
import type { Workspace } from "@/lib/workspaces";
import { Avatar, RoleBadge } from "@/app/components/WorkspaceDialogs";
import { Badge, Button, Card, DataTable, RowActionsMenu, formatDay, type Column } from "@/app/components/ui";
import { AvatarStack, CountRow, KIND_STYLES, KindTile, SelectedPill, memberLabel, scopeCounts, type WorkspaceKind } from "./parts";
import { PERSONAL_KEY, firmwareCount, type ScopeResources } from "./useWorkspaceResources";

const LOCKED_TITLE = "Finish the upload or change in progress before switching";

/** Switches the app to this scope through WorkspaceContext; shows "Selected" when it already is. */
export function SwitchControl({ selected, onSwitch, label }: { selected: boolean; onSwitch: () => void; label: string }) {
  const { scopeLocked } = useWorkspace();
  if (selected) return <SelectedPill />;
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={ArrowRightLeft}
      onClick={onSwitch}
      disabled={scopeLocked}
      title={scopeLocked ? LOCKED_TITLE : undefined}
      aria-label={label}
      className="relative z-10"
    >
      Switch
    </Button>
  );
}

function CardShell({
  kind,
  selected,
  badge,
  children,
}: {
  kind: WorkspaceKind;
  selected: boolean;
  badge: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card
      className={`relative overflow-hidden flex flex-col transition-shadow hover:shadow-md hover:border-line-strong focus-within:border-line-strong ${
        selected ? "ring-2 ring-brand-500/40 border-brand-200" : ""
      }`}
    >
      <div className={`h-12 border-b ${KIND_STYLES[kind].band}`} aria-hidden="true" />
      <div className="px-4 -mt-6 flex items-end justify-between gap-3">
        <KindTile kind={kind} />
        <div className="pb-0.5">{badge}</div>
      </div>
      {children}
    </Card>
  );
}

export function WorkspaceCard({
  workspace,
  resources,
  selected,
  onOpen,
}: {
  workspace: Workspace;
  resources: ScopeResources | undefined;
  selected: boolean;
  onOpen: () => void;
}) {
  const { selectWorkspace } = useWorkspace();
  const members = resources?.members;
  return (
    <CardShell kind={workspace.role} selected={selected} badge={<RoleBadge role={workspace.role} />}>
      <div className="px-4 pt-3 flex-1">
        {/* The title is the card's main action: it covers the card, under the footer controls. */}
        <button
          type="button"
          onClick={onOpen}
          className="block text-left text-sm font-semibold text-slate-900 hover:text-brand-700 truncate max-w-full after:absolute after:inset-0 focus:outline-none focus-visible:after:ring-2 focus-visible:after:ring-brand-500/40 focus-visible:after:rounded-xl"
        >
          {workspace.name}
        </button>
        <p className="text-xs text-slate-500 mt-0.5">
          {workspace.role === "owner" ? "You own this workspace" : "Shared with you"} · Created {formatDay(workspace.createdAt)}
        </p>
        <CountRow counts={scopeCounts(resources, false)} className="mt-3" />
      </div>
      <div className="mt-4 px-4 py-3 border-t border-line flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {members && members.length > 0 && <AvatarStack members={members} />}
          <span className="text-xs text-slate-500 truncate">{memberLabel(members)}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0 relative z-10">
          <SwitchControl
            selected={selected}
            onSwitch={() => selectWorkspace(workspace)}
            label={`Switch to ${workspace.name}`}
          />
          <RowActionsMenu
            label={`Actions for ${workspace.name}`}
            actions={[
              { label: "View workspace", icon: Eye, onSelect: onOpen },
              !selected && { label: "Switch to workspace", icon: ArrowRightLeft, onSelect: () => selectWorkspace(workspace) },
            ]}
          />
        </div>
      </div>
    </CardShell>
  );
}

/** Personal: only the signed-in user sees it. Same switching as before; it has no members or invitations. */
export function PersonalCard({
  resources,
  selected,
  email,
}: {
  resources: ScopeResources | undefined;
  selected: boolean;
  /** The user's email when a workspace member list has it; the Cognito username is an opaque id. */
  email: string | null;
}) {
  const { selectPersonal } = useWorkspace();
  return (
    <CardShell kind="personal" selected={selected} badge={<Badge tone="neutral">Private</Badge>}>
      <div className="px-4 pt-3 flex-1">
        <p className="text-sm font-semibold text-slate-900">Personal</p>
        <p className="text-xs text-slate-500 mt-0.5">Only you can see this workspace.</p>
        <CountRow counts={scopeCounts(resources, false)} className="mt-3" />
      </div>
      <div className="mt-4 px-4 py-3 border-t border-line flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {email ? (
            <Avatar email={email} size="sm" />
          ) : (
            <span className="h-7 w-7 rounded-full bg-surface-sunken text-slate-500 flex items-center justify-center">
              <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
          <span className="text-xs text-slate-500">Just you</span>
        </div>
        <SwitchControl selected={selected} onSwitch={selectPersonal} label="Switch to Personal" />
      </div>
    </CardShell>
  );
}

type Row = { kind: "personal" } | { kind: "workspace"; workspace: Workspace };

/** The same workspaces as a table; clicking a workspace row opens it. */
export function WorkspaceTable({
  rows,
  resources,
  selectedKey,
  onOpen,
}: {
  rows: Row[];
  resources: Record<string, ScopeResources>;
  selectedKey: string;
  onOpen: (workspace: Workspace) => void;
}) {
  const { selectPersonal, selectWorkspace } = useWorkspace();
  const keyOf = (row: Row) => (row.kind === "personal" ? PERSONAL_KEY : row.workspace.workspaceId);
  const count = (list: unknown[] | null | undefined) => (list === undefined ? "…" : list === null ? "—" : list.length);

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Workspace",
      cell: (row) => {
        const kind: WorkspaceKind = row.kind === "personal" ? "personal" : row.workspace.role;
        const Icon = KIND_STYLES[kind].icon;
        return (
          <div className="flex items-center gap-3 min-w-0">
            <span className={`h-8 w-8 shrink-0 rounded-lg border flex items-center justify-center ${KIND_STYLES[kind].band} ${KIND_STYLES[kind].tile}`}>
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="font-medium text-slate-900 truncate">{row.kind === "personal" ? "Personal" : row.workspace.name}</p>
              <p className="text-xs text-slate-500">
                {row.kind === "personal" ? "Only you can see this workspace" : `Created ${formatDay(row.workspace.createdAt)}`}
              </p>
            </div>
          </div>
        );
      },
      className: "align-middle",
    },
    {
      key: "role",
      header: "Role",
      cell: (row) => (row.kind === "personal" ? <Badge tone="neutral">Private</Badge> : <RoleBadge role={row.workspace.role} />),
      className: "align-middle",
    },
    {
      key: "members",
      header: "Members",
      cell: (row) => (row.kind === "personal" ? 1 : count(resources[keyOf(row)]?.members)),
      hideBelow: "sm",
      className: "align-middle tabular-nums text-slate-700",
    },
    {
      key: "devices",
      header: "Devices",
      cell: (row) => count(resources[keyOf(row)]?.devices),
      hideBelow: "md",
      className: "align-middle tabular-nums text-slate-700",
    },
    {
      key: "firmware",
      header: "Firmware",
      cell: (row) => {
        const firmware = resources[keyOf(row)]?.firmware;
        return firmware === undefined ? "…" : firmwareCount(firmware) ?? "—";
      },
      hideBelow: "md",
      className: "align-middle tabular-nums text-slate-700",
    },
    {
      key: "cves",
      header: "CVEs",
      cell: (row) => count(resources[keyOf(row)]?.cves),
      hideBelow: "md",
      className: "align-middle tabular-nums text-slate-700",
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      cell: (row) => (
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {row.kind === "personal" ? (
            <SwitchControl selected={selectedKey === PERSONAL_KEY} onSwitch={selectPersonal} label="Switch to Personal" />
          ) : (
            <SwitchControl
              selected={selectedKey === row.workspace.workspaceId}
              onSwitch={() => selectWorkspace(row.workspace)}
              label={`Switch to ${row.workspace.name}`}
            />
          )}
        </div>
      ),
      className: "align-middle",
    },
  ];

  return (
    <Card className="overflow-hidden">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={keyOf}
        onRowClick={(row) => row.kind === "workspace" && onOpen(row.workspace)}
        rowLabel={(row) => (row.kind === "workspace" ? `Open ${row.workspace.name}` : "Personal")}
        rowClassName={(row) => (keyOf(row) === selectedKey ? "bg-brand-50/40" : "")}
        minWidth="32rem"
      />
    </Card>
  );
}

const GET_STARTED = [
  { icon: UserPlus, title: "Invite your team", text: "Add teammates by email and start collaborating." },
  { icon: FolderOpen, title: "Share resources", text: "Devices, firmware and research data in one place." },
  { icon: ShieldCheck, title: "Track vulnerabilities", text: "Keep CVEs and their linked devices organized." },
];

/** Shown instead of the gallery when the user isn't in any workspace yet. */
export function NoWorkspaces({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="px-6 py-10 sm:py-12">
      <div className="flex flex-col items-center text-center">
        <span className="relative h-16 w-16 rounded-2xl bg-brand-50 text-brand-600 flex items-center justify-center">
          <Building2 className="h-8 w-8" aria-hidden="true" />
          <span className="absolute -right-2 -bottom-2 h-7 w-7 rounded-full bg-brand-600 text-white flex items-center justify-center ring-4 ring-white">
            <Plus className="h-4 w-4" aria-hidden="true" />
          </span>
        </span>
        <h2 className="mt-5 text-lg font-semibold text-slate-900">No workspaces yet</h2>
        <p className="mt-1 text-sm text-slate-500 max-w-md">
          Create a workspace to start collaborating with your team on devices, firmware and vulnerability research.
        </p>
        <Button icon={Plus} onClick={onCreate} className="mt-5">
          Create your first workspace
        </Button>
      </div>
      <ul className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {GET_STARTED.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex gap-3 rounded-lg border border-line p-3.5">
            <span className="h-9 w-9 shrink-0 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-medium text-slate-800">{title}</p>
              <p className="text-xs text-slate-500 mt-0.5">{text}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
