"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Building2, Cpu, LayoutGrid, List, Plus, SearchX, ShieldAlert, Users, type LucideIcon } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useWorkspace } from "@/context/WorkspaceContext";
import type { Workspace } from "@/lib/workspaces";
import {
  WORKSPACE_SORT_LABELS,
  filterAndSortWorkspaces,
  personalMatches,
  summarizeWorkspaces,
  type SummaryFigure,
  type WorkspaceSort,
} from "@/lib/workspaceGallery";
import { InvitationsList } from "@/app/components/WorkspaceDialogs";
import { NoWorkspaces, PersonalCard, WorkspaceCard, WorkspaceTable } from "@/app/components/workspaces/WorkspaceGallery";
import { WorkspaceOverview } from "@/app/components/workspaces/WorkspaceOverview";
import { PERSONAL_KEY, useWorkspaceResources } from "@/app/components/workspaces/useWorkspaceResources";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  FilterSelect,
  LoadingState,
  MetricCard,
  PageHeader,
  SearchInput,
} from "@/app/components/ui";

/**
 * The user's workspaces, their members and invitations. Everything here goes
 * through WorkspaceContext and the existing workspace API: create, invite
 * (owners), accept/decline and switch. There is no member removal, role change
 * or workspace deletion. ?id= opens one workspace.
 */
export default function WorkspacesPage() {
  // useSearchParams needs a Suspense boundary under static export.
  return (
    <Suspense fallback={<LoadingState />}>
      <WorkspacesView />
    </Suspense>
  );
}

type View = "workspaces" | "invitations";
type Layout = "grid" | "list";

function WorkspacesView() {
  const router = useRouter();
  const openId = useSearchParams().get("id");
  const { user } = useAuth();
  const { scope, scopeReady, workspaces, workspacesError, invitations, openPanel } = useWorkspace();
  const resources = useWorkspaceResources(workspaces);

  const [view, setView] = useState<View>("workspaces");
  const [layout, setLayout] = useState<Layout>("grid");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<WorkspaceSort>("updated");

  const shown = useMemo(() => filterAndSortWorkspaces(workspaces ?? [], query, sort), [workspaces, query, sort]);
  const summary = useMemo(
    () =>
      summarizeWorkspaces(
        (workspaces ?? []).map((w) => {
          const r = resources[w.workspaceId];
          return { members: r?.members, devices: lengthOf(r?.devices), cves: lengthOf(r?.cves) };
        })
      ),
    [workspaces, resources]
  );
  // The user's email, for the Personal avatar, from any member list that has it.
  const ownEmail = useMemo(() => {
    for (const r of Object.values(resources)) {
      const me = r.members?.find((m) => m.userId === user?.userId);
      if (me?.email) return me.email;
    }
    return null;
  }, [resources, user?.userId]);

  if (!scopeReady) return <LoadingState label="Loading workspace…" />;

  const selectedKey = scope.kind === "workspace" ? scope.workspaceId : PERSONAL_KEY;
  const open = (workspace: Workspace) => router.push(`/workspaces?id=${encodeURIComponent(workspace.workspaceId)}`);
  const back = () => router.push("/workspaces");

  if (openId) {
    const workspace = workspaces?.find((w) => w.workspaceId === openId);
    if (workspace) {
      return <WorkspaceOverview key={workspace.workspaceId} workspace={workspace} resources={resources[workspace.workspaceId]} onBack={back} />;
    }
    if (workspaces === null && !workspacesError) return <LoadingState />;
    return (
      <Card>
        <EmptyState
          icon={Building2}
          title="Workspace not found"
          description="It may have been removed, or you no longer have access to it."
          action={
            <Button variant="secondary" onClick={back}>
              Back to workspaces
            </Button>
          }
        />
      </Card>
    );
  }

  const invitationCount = invitations?.length;
  const showPersonal = personalMatches(query);
  const noWorkspaces = workspaces !== null && workspaces.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspaces"
        description="Share devices, firmware and vulnerability research with your team."
        actions={
          <Button icon={Plus} onClick={() => openPanel("create")}>
            Create workspace
          </Button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <MetricCard
          label="Total workspaces"
          icon={Building2}
          value={workspaces?.length ?? "—"}
          loading={workspaces === null && !workspacesError}
          hint="Plus your Personal workspace"
        />
        <SummaryMetric label="Total members" icon={Users} figure={summary.members} hint="Unique people across workspaces" />
        <SummaryMetric label="Shared devices" icon={Cpu} figure={summary.devices} hint="In your workspaces" />
        <SummaryMetric label="CVE entries" icon={ShieldAlert} figure={summary.cves} hint="In your workspaces" />
      </div>

      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="flex gap-1 p-1 rounded-lg bg-surface-sunken self-start" role="tablist" aria-label="Workspaces or invitations">
          <ViewTab active={view === "workspaces"} onClick={() => setView("workspaces")} icon={Building2}>
            My workspaces{workspaces ? ` (${workspaces.length})` : ""}
          </ViewTab>
          <ViewTab active={view === "invitations"} onClick={() => setView("invitations")} icon={Users}>
            Invitations{invitationCount !== undefined ? ` (${invitationCount})` : ""}
          </ViewTab>
        </div>
        {view === "workspaces" && !noWorkspaces && (
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            <SearchInput value={query} onChange={setQuery} placeholder="Search workspaces…" ariaLabel="Search workspaces" className="sm:w-60" />
            <FilterSelect value={sort} onChange={(v) => setSort(v as WorkspaceSort)} ariaLabel="Sort workspaces">
              {(Object.keys(WORKSPACE_SORT_LABELS) as WorkspaceSort[]).map((key) => (
                <option key={key} value={key}>
                  {WORKSPACE_SORT_LABELS[key]}
                </option>
              ))}
            </FilterSelect>
            <div className="flex rounded-lg border border-line bg-white shadow-sm p-0.5" role="group" aria-label="Layout">
              <LayoutButton active={layout === "grid"} onClick={() => setLayout("grid")} icon={LayoutGrid} label="Grid view" />
              <LayoutButton active={layout === "list"} onClick={() => setLayout("list")} icon={List} label="List view" />
            </div>
          </div>
        )}
      </div>

      {view === "invitations" ? (
        <Card>
          <div className="px-5 py-4 border-b border-line">
            <h2 className="text-sm font-semibold text-slate-800">Invitations to you</h2>
            <p className="text-xs text-slate-500 mt-0.5">Workspaces you&apos;ve been invited to join.</p>
          </div>
          <div className="p-5">
            <InvitationsList onAccepted={() => setView("workspaces")} />
          </div>
        </Card>
      ) : (
        <section aria-label="Your workspaces" className="space-y-4">
          {workspacesError && <Alert tone="error">{workspacesError}</Alert>}
          {workspaces === null && !workspacesError && <LoadingState />}
          {noWorkspaces && <NoWorkspaces onCreate={() => openPanel("create")} />}

          {(workspaces !== null || workspacesError) &&
            (shown.length === 0 && !showPersonal ? (
              <Card>
                <EmptyState
                  icon={SearchX}
                  title="No workspaces match your search"
                  action={
                    <Button variant="secondary" onClick={() => setQuery("")}>
                      Clear search
                    </Button>
                  }
                />
              </Card>
            ) : layout === "list" && !noWorkspaces ? (
              <WorkspaceTable
                rows={[
                  ...(showPersonal ? [{ kind: "personal" as const }] : []),
                  ...shown.map((workspace) => ({ kind: "workspace" as const, workspace })),
                ]}
                resources={resources}
                selectedKey={selectedKey}
                onOpen={open}
              />
            ) : (
              <>
                {noWorkspaces && <h2 className="text-sm font-semibold text-slate-800">Your Personal workspace</h2>}
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  {showPersonal && (
                    <PersonalCard resources={resources[PERSONAL_KEY]} selected={selectedKey === PERSONAL_KEY} email={ownEmail} />
                  )}
                  {shown.map((workspace) => (
                    <WorkspaceCard
                      key={workspace.workspaceId}
                      workspace={workspace}
                      resources={resources[workspace.workspaceId]}
                      selected={selectedKey === workspace.workspaceId}
                      onOpen={() => open(workspace)}
                    />
                  ))}
                </div>
              </>
            ))}
        </section>
      )}
    </div>
  );
}

/** A loaded list's length, keeping undefined (loading) and null (failed). */
function lengthOf(list: unknown[] | null | undefined): number | null | undefined {
  return list ? list.length : list;
}

function SummaryMetric({
  label,
  icon,
  figure,
  hint,
}: {
  label: string;
  icon: LucideIcon;
  figure: SummaryFigure;
  hint: string;
}) {
  return (
    <MetricCard
      label={label}
      icon={icon}
      value={figure.incomplete ? `${figure.value}+` : figure.value}
      loading={figure.loading}
      hint={figure.incomplete ? "Some workspaces couldn't be counted" : hint}
    />
  );
}

function ViewTab({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-sm font-medium transition-colors ${
        active ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {children}
    </button>
  );
}

function LayoutButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`h-7 w-7 rounded-md flex items-center justify-center transition-colors ${
        active ? "bg-brand-600 text-white" : "text-slate-500 hover:text-slate-800 hover:bg-surface-sunken"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
