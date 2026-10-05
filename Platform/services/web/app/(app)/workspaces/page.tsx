"use client";

import { useState } from "react";
import { ArrowRightLeft, Building2, Check, Plus, UserRound, Users } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useWorkspace } from "@/context/WorkspaceContext";
import type { Workspace } from "@/lib/workspaces";
import { InvitationsList, MembersPanel, RoleBadge, useWorkspaceDetail } from "@/app/components/WorkspaceDialogs";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  LoadingState,
  PageHeader,
  formatDay,
} from "@/app/components/ui";

/**
 * The user's workspaces, their members and invitations. Everything here goes
 * through WorkspaceContext and the existing workspace API: create, invite
 * (owners), accept/decline and switch. There is no member removal, role change
 * or workspace deletion.
 */
export default function WorkspacesPage() {
  const { scope, scopeReady, workspaces, workspacesError, openPanel } = useWorkspace();
  const [chosenId, setChosenId] = useState<string | null>(null);

  if (!scopeReady) return <LoadingState label="Loading workspace…" />;

  // Members shown: the chosen card, else the selected workspace, else the first.
  const currentId = scope.kind === "workspace" ? scope.workspaceId : null;
  const shownId =
    (chosenId && workspaces?.some((w) => w.workspaceId === chosenId) ? chosenId : null) ??
    (currentId && workspaces?.some((w) => w.workspaceId === currentId) ? currentId : null) ??
    workspaces?.[0]?.workspaceId ??
    null;
  const shown = workspaces?.find((w) => w.workspaceId === shownId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspaces"
        description="Share devices, firmware and vulnerability research with your team"
        actions={
          <Button icon={Plus} onClick={() => openPanel("create")}>
            Create workspace
          </Button>
        }
      />

      <Card>
        <CardHeader title="Invitations to you" description="Workspaces you've been invited to join" />
        <div className="p-5">
          <InvitationsList />
        </div>
      </Card>

      <section>
        <h2 className="text-sm font-semibold text-slate-800 mb-3">Your workspaces</h2>
        {workspacesError && <Alert tone="error" className="mb-3">{workspacesError}</Alert>}
        {workspaces === null ? (
          !workspacesError && <LoadingState />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            <PersonalCard selected={scope.kind === "personal"} />
            {workspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.workspaceId}
                workspace={workspace}
                current={workspace.workspaceId === currentId}
                shown={workspace.workspaceId === shownId}
                onShow={() => setChosenId(workspace.workspaceId)}
              />
            ))}
          </div>
        )}
        {workspaces && workspaces.length === 0 && (
          <Card className="mt-4">
            <EmptyState
              icon={Users}
              title="You're not in any workspace yet"
              description="Create a workspace to share devices and findings, or accept an invitation above."
              action={
                <Button icon={Plus} onClick={() => openPanel("create")}>
                  Create workspace
                </Button>
              }
            />
          </Card>
        )}
      </section>

      {shown && <MembersSection key={shown.workspaceId} workspace={shown} />}
    </div>
  );
}

function PersonalCard({ selected }: { selected: boolean }) {
  const { selectPersonal, scopeLocked } = useWorkspace();
  return (
    <Card className={`p-4 flex flex-col ${selected ? "ring-2 ring-brand-500/40 border-brand-200" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="h-9 w-9 shrink-0 rounded-lg bg-surface-sunken text-slate-600 flex items-center justify-center">
            <UserRound className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">Personal</p>
            <p className="text-xs text-slate-500">Only you can see it</p>
          </div>
        </div>
        {selected && <CurrentPill />}
      </div>
      <div className="mt-4 pt-3 border-t border-line flex justify-end">
        <Button
          variant="secondary"
          size="sm"
          icon={ArrowRightLeft}
          onClick={selectPersonal}
          disabled={selected || scopeLocked}
          title={scopeLocked ? "Finish the upload or change in progress before switching" : undefined}
        >
          {selected ? "Current" : "Switch to Personal"}
        </Button>
      </div>
    </Card>
  );
}

function WorkspaceCard({
  workspace,
  current,
  shown,
  onShow,
}: {
  workspace: Workspace;
  current: boolean;
  shown: boolean;
  onShow: () => void;
}) {
  const { selectWorkspace, scopeLocked } = useWorkspace();
  return (
    <Card className={`p-4 flex flex-col ${shown ? "ring-2 ring-brand-500/40 border-brand-200" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="h-9 w-9 shrink-0 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
            <Building2 className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900 truncate">{workspace.name}</p>
            <p className="text-xs text-slate-500">Created {formatDay(workspace.createdAt)}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <RoleBadge role={workspace.role} />
          {current && <CurrentPill />}
        </div>
      </div>
      <div className="mt-4 pt-3 border-t border-line flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" icon={Users} onClick={onShow} aria-pressed={shown}>
          Members
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={ArrowRightLeft}
          onClick={() => selectWorkspace(workspace)}
          disabled={current || scopeLocked}
          title={scopeLocked ? "Finish the upload or change in progress before switching" : undefined}
        >
          {current ? "Current" : "Switch to"}
        </Button>
      </div>
    </Card>
  );
}

function CurrentPill() {
  return (
    <span className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-emerald-700">
      <Check className="h-3 w-3" aria-hidden="true" />
      Selected
    </span>
  );
}

function MembersSection({ workspace }: { workspace: Workspace }) {
  const { user } = useAuth();
  const { detail, error, invite } = useWorkspaceDetail(workspace.workspaceId);
  return (
    <Card>
      <CardHeader
        title={`${workspace.name} · members`}
        description={workspace.role === "owner" ? "You own this workspace and can invite members." : "You are a member of this workspace."}
      />
      <div className="p-5">
        {error && <Alert tone="error" className="mb-4">{error}</Alert>}
        {detail ? (
          <MembersPanel detail={detail} currentUserId={user?.userId ?? null} onInvite={invite} />
        ) : (
          !error && <LoadingState />
        )}
      </div>
    </Card>
  );
}
