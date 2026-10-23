"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, FolderOpen, Inbox, Info, Mail, ShieldCheck, UserPlus, Users } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useWorkspace } from "@/context/WorkspaceContext";
import {
  acceptWorkspaceInvitation,
  createWorkspace,
  declineWorkspaceInvitation,
  describeError,
  getWorkspace,
  inviteWorkspaceMember,
  isWorkspaceUnavailable,
  type WorkspaceDetail,
  type WorkspaceInvite,
  type WorkspaceMember,
  type WorkspaceRole,
} from "@/lib/workspaces";
import { ApiError } from "@/lib/api";
import {
  Alert,
  Badge,
  DataTable,
  Dialog,
  EmptyState,
  LoadingState,
  formatDate,
  initials,
  inputClass,
  labelClass,
  primaryButton,
  secondaryButton,
  type Column,
} from "@/app/components/ui";

/** The workspace dialogs, opened from the top bar, the dashboard and the Workspaces page. */
export default function WorkspaceDialogs() {
  const { panel, scope } = useWorkspace();
  if (panel === "create") return <CreateWorkspaceDialog />;
  if (panel === "invitations") return <InvitationsDialog />;
  if (panel === "members" && scope.kind === "workspace") {
    return <MembersDialog key={scope.workspaceId} workspaceId={scope.workspaceId} />;
  }
  return null;
}

/** "You no longer have access to …" after the selected workspace became unavailable. */
export function WorkspaceNotice() {
  const { notice, dismissNotice } = useWorkspace();
  if (!notice) return null;
  return (
    <Alert tone="warning" onDismiss={dismissNotice} className="mb-6 text-sm">
      {notice}
    </Alert>
  );
}

// --- Create workspace ----------------------------------------------------------

function CreateWorkspaceDialog() {
  const { closePanel, refreshWorkspaces, selectWorkspace } = useWorkspace();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (!submitting) closePanel();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const workspace = await createWorkspace(trimmed);
      await refreshWorkspaces();
      selectWorkspace(workspace);
      closePanel();
    } catch (err) {
      setError(describeError(err, "Couldn't create the workspace"));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title="Create a new workspace"
      subtitle="A shared space for your team's devices, firmware and CVEs"
      onClose={close}
      size="xl"
      aside={<CreateWorkspaceAside />}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className={labelClass} htmlFor="workspace-name">
            Workspace name <span className="text-red-500" aria-hidden="true">*</span>
          </label>
          <input
            id="workspace-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            maxLength={100}
            className={inputClass}
            placeholder="e.g. Infusion pump research"
            autoFocus
            required
          />
          <p className="text-2xs text-slate-400 mt-1 text-right tabular-nums">{name.length}/100</p>
        </div>
        <div className="flex items-start gap-3 rounded-lg border border-line bg-surface-muted px-3 py-3">
          <span className="h-8 w-8 shrink-0 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
            <Users className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="text-xs text-slate-600">
            <p className="font-medium text-slate-800">Visible to members you invite</p>
            <p className="mt-0.5">
              You&apos;ll be the owner and can invite teammates. For work only you can see, use your Personal workspace.
            </p>
          </div>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
          <button type="button" onClick={close} disabled={submitting} className={secondaryButton}>
            Cancel
          </button>
          <button type="submit" disabled={submitting || !name.trim()} className={primaryButton}>
            {submitting ? "Creating…" : "Create workspace"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const CREATE_POINTS = [
  { icon: FolderOpen, title: "Share devices & firmware", text: "Work together on uploaded files and research data." },
  { icon: UserPlus, title: "Invite team members", text: "Owners invite teammates by their verified email." },
  { icon: ShieldCheck, title: "Track vulnerabilities", text: "Keep CVEs and linked devices in one place." },
];

function CreateWorkspaceAside() {
  return (
    <>
      <span className="h-12 w-12 rounded-xl bg-white/10 ring-1 ring-white/15 flex items-center justify-center">
        <Building2 className="h-6 w-6 text-brand-200" aria-hidden="true" />
      </span>
      <p className="mt-4 text-lg font-semibold tracking-tight">Create a workspace</p>
      <p className="mt-1 text-sm text-navy-200">
        Collaborate with your team on device analysis, firmware research and vulnerability tracking.
      </p>
      <ul className="mt-6 space-y-4">
        {CREATE_POINTS.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex gap-3">
            <span className="h-8 w-8 shrink-0 rounded-lg bg-white/10 flex items-center justify-center">
              <Icon className="h-4 w-4 text-brand-200" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-medium">{title}</p>
              <p className="text-xs text-navy-300 mt-0.5">{text}</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

// --- Members -------------------------------------------------------------------

/**
 * A workspace with its members (and, for owners, pending invitations), plus
 * invite. Used by the members dialog and the Workspaces page.
 */
export function useWorkspaceDetail(workspaceId: string) {
  const { reportWorkspaceUnavailable } = useWorkspace();
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    try {
      const result = await getWorkspace(workspaceId);
      if (loadId !== loadIdRef.current) return;
      setDetail(result);
      setError(null);
    } catch (err) {
      if (loadId !== loadIdRef.current) return;
      if (isWorkspaceUnavailable(err)) {
        setError("This workspace is no longer available to you.");
        reportWorkspaceUnavailable();
      } else {
        setError(describeError(err, "Couldn't load the workspace"));
      }
    }
  }, [workspaceId, reportWorkspaceUnavailable]);

  useEffect(() => {
    void load();
    // Invalidates the in-flight load when the view closes or reloads.
    const loadIds = loadIdRef;
    return () => {
      loadIds.current++;
    };
  }, [load]);

  const invite = useCallback(
    async (email: string): Promise<WorkspaceInvite> => {
      const created = await inviteWorkspaceMember(workspaceId, email);
      await load();
      return created;
    },
    [workspaceId, load]
  );

  return { detail, error, invite };
}

function MembersDialog({ workspaceId }: { workspaceId: string }) {
  const { user } = useAuth();
  const { closePanel } = useWorkspace();
  const { detail, error, invite } = useWorkspaceDetail(workspaceId);

  return (
    <Dialog title={detail?.workspace.name ?? "Workspace"} subtitle="Members and invitations" onClose={closePanel} wide>
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}
      {detail ? (
        <MembersPanel detail={detail} currentUserId={user?.userId ?? null} onInvite={invite} />
      ) : (
        !error && <LoadingState />
      )}
    </Dialog>
  );
}

export function RoleBadge({ role }: { role: WorkspaceRole }) {
  return role === "owner" ? <Badge tone="brand">Owner</Badge> : <Badge tone="neutral">Member</Badge>;
}

export function Avatar({ email, size = "md" }: { email: string | null; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-7 w-7 text-2xs" : "h-8 w-8 text-xs";
  return (
    <span
      className={`${box} shrink-0 rounded-full bg-navy-800 text-white font-semibold flex items-center justify-center ring-2 ring-white`}
      title={email ?? undefined}
    >
      {initials(email)}
    </span>
  );
}

/** A workspace's members: who they are, their role and when they joined. */
export function MembersTable({ members, currentUserId }: { members: WorkspaceMember[]; currentUserId: string | null }) {
  const columns: Column<WorkspaceMember>[] = [
    {
      key: "member",
      header: "Member",
      cell: (member) => (
        <div className="flex items-center gap-3 min-w-0">
          <Avatar email={member.email} />
          <p className="text-sm text-slate-800 truncate">
            {member.email ?? <span className="text-slate-400">Email not verified</span>}
            {member.userId === currentUserId && <span className="text-slate-400"> (you)</span>}
          </p>
        </div>
      ),
      className: "align-middle",
    },
    { key: "role", header: "Role", cell: (member) => <RoleBadge role={member.role} />, className: "align-middle" },
    {
      key: "joined",
      header: "Joined",
      cell: (member) => <span className="text-slate-600">{member.joinedAt ? formatDate(member.joinedAt) : "—"}</span>,
      hideBelow: "sm",
      className: "align-middle whitespace-nowrap",
    },
  ];
  return (
    <div className="border border-line rounded-lg overflow-hidden">
      <DataTable columns={columns} rows={members} rowKey={(m) => m.userId} minWidth="28rem" />
    </div>
  );
}

/**
 * The owner's invite form. The backend re-checks ownership on every
 * invitation; onInvite reloads the workspace so pending invitations update.
 */
export function InviteMemberForm({ onInvite }: { onInvite: (email: string) => Promise<WorkspaceInvite> }) {
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteDone, setInviteDone] = useState<string | null>(null);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || inviting) return;
    setInviting(true);
    setInviteError(null);
    setInviteDone(null);
    try {
      const invite = await onInvite(trimmed);
      setEmail("");
      setInviteDone(
        `Invitation created for ${invite.email}. They will see it when they sign in with this verified email address.`
      );
    } catch (err) {
      setInviteError(describeError(err, "Couldn't create the invitation"));
    } finally {
      setInviting(false);
    }
  }

  return (
    <div>
      <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Mail className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={inviting}
            placeholder="teammate@example.com"
            aria-label="Email address to invite"
            className={`${inputClass} pl-9`}
          />
        </div>
        <button type="submit" disabled={inviting || !email.trim()} className={primaryButton}>
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          {inviting ? "Inviting…" : "Invite member"}
        </button>
      </form>
      <p className="text-xs text-slate-500 mt-1.5 flex items-center gap-1">
        <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Invitations are shown in the app; no email is sent. They join as a member.
      </p>
      {inviteDone && <Alert tone="success" className="mt-2">{inviteDone}</Alert>}
      {inviteError && <Alert tone="error" className="mt-2">{inviteError}</Alert>}
    </div>
  );
}

/** Invitations the workspace has sent that haven't been answered (owners only). */
export function PendingInvitesTable({ detail }: { detail: WorkspaceDetail }) {
  const emailsById = new Map(detail.members.map((m) => [m.userId, m.email]));
  const invites = detail.invites ?? [];
  if (invites.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No pending invitations"
        description="Invitations you send appear here until they're accepted or declined."
        className="py-10 border border-dashed border-line rounded-lg"
      />
    );
  }
  const columns: Column<WorkspaceInvite>[] = [
    {
      key: "email",
      header: "Invited",
      cell: (invite) => (
        <div className="flex items-center gap-3 min-w-0">
          <Avatar email={invite.email} />
          <span className="text-sm text-slate-800 truncate">{invite.email}</span>
        </div>
      ),
      className: "align-middle",
    },
    {
      key: "by",
      header: "Invited by",
      cell: (invite) => (
        <span className="text-slate-600">{invite.invitedByEmail ?? emailsById.get(invite.invitedBy) ?? "an owner"}</span>
      ),
      hideBelow: "md",
      className: "align-middle",
    },
    {
      key: "expires",
      header: "Expires",
      cell: (invite) => <span className="text-slate-600">{formatDate(invite.expiresAt)}</span>,
      hideBelow: "sm",
      className: "align-middle whitespace-nowrap",
    },
    { key: "status", header: "Status", cell: () => <Badge tone="warning" dot>Pending</Badge>, className: "align-middle" },
  ];
  return (
    <div className="border border-line rounded-lg overflow-hidden">
      <DataTable columns={columns} rows={invites} rowKey={(i) => i.email} minWidth="28rem" />
    </div>
  );
}

/**
 * Members, and for owners the invite form and pending invitations. Whether
 * the user is an owner comes from the workspace the backend returned, which
 * also re-checks it on every invitation. Used by the members dialog.
 */
export function MembersPanel({
  detail,
  currentUserId,
  onInvite,
}: {
  detail: WorkspaceDetail;
  currentUserId: string | null;
  onInvite: (email: string) => Promise<WorkspaceInvite>;
}) {
  const isOwner = detail.workspace.role === "owner";
  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
          Members ({detail.members.length})
        </h3>
        <MembersTable members={detail.members} currentUserId={currentUserId} />
      </section>

      {isOwner ? (
        <>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Invite a member</h3>
            <InviteMemberForm onInvite={onInvite} />
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Pending invitations</h3>
            <PendingInvitesTable detail={detail} />
          </section>
        </>
      ) : (
        <p className="text-sm text-slate-500">Only workspace owners can invite members.</p>
      )}
    </div>
  );
}

// --- Invitations for the signed-in user -------------------------------------------

/**
 * Invitations addressed to the signed-in user, with Accept and Decline.
 * Accepting switches to the workspace (unless a write is running) and calls
 * onAccepted. Used by the invitations dialog and the Workspaces page.
 */
export function InvitationsList({ onAccepted }: { onAccepted?: () => void }) {
  const {
    invitations,
    invitationsError,
    refreshInvitations,
    refreshWorkspaces,
    selectWorkspace,
    scopeLocked,
  } = useWorkspace();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    void refreshInvitations();
  }, [refreshInvitations]);

  function setRowError(workspaceId: string, message: string | null) {
    setErrors((current) => {
      const next = { ...current };
      if (message) next[workspaceId] = message;
      else delete next[workspaceId];
      return next;
    });
  }

  async function act(workspaceId: string, action: "accept" | "decline") {
    if (busy) return;
    setBusy(workspaceId);
    setRowError(workspaceId, null);
    try {
      if (action === "accept") {
        const workspace = await acceptWorkspaceInvitation(workspaceId);
        await Promise.all([refreshInvitations(), refreshWorkspaces()]);
        if (!scopeLocked) {
          selectWorkspace(workspace);
          onAccepted?.();
        }
      } else {
        await declineWorkspaceInvitation(workspaceId);
        setHidden((current) => new Set(current).add(workspaceId));
        await refreshInvitations();
      }
    } catch (err) {
      const fallback = action === "accept" ? "Couldn't accept the invitation" : "Couldn't decline the invitation";
      const message =
        err instanceof ApiError && err.status === 404
          ? "This invitation is no longer available."
          : describeError(err, fallback);
      setRowError(workspaceId, message);
      // An expired or withdrawn invitation may have changed the list.
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) void refreshInvitations();
    } finally {
      setBusy(null);
    }
  }

  const shown = (invitations ?? []).filter((i) => !hidden.has(i.workspaceId));

  return (
    <>
      {invitationsError && <Alert tone="error" className="mb-4">{invitationsError}</Alert>}
      {invitations === null ? (
        !invitationsError && <LoadingState />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No pending invitations"
          description="When someone invites you to a workspace, it will appear here."
          className="py-10"
        />
      ) : (
        <ul className="divide-y divide-line border border-line rounded-lg">
          {shown.map((invitation) => (
            <li key={invitation.workspaceId} className="px-4 py-3.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="h-9 w-9 shrink-0 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
                    <Building2 className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{invitation.workspaceName}</p>
                    <p className="text-xs text-slate-500">
                      Invited by {invitation.invitedByEmail ?? "a workspace owner"} · Expires{" "}
                      {formatDate(invitation.expiresAt)}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void act(invitation.workspaceId, "decline")}
                    disabled={busy !== null}
                    className={secondaryButton}
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    onClick={() => void act(invitation.workspaceId, "accept")}
                    disabled={busy !== null}
                    className={primaryButton}
                  >
                    {busy === invitation.workspaceId ? "…" : "Accept"}
                  </button>
                </div>
              </div>
              {errors[invitation.workspaceId] && (
                <Alert tone="error" className="mt-2">{errors[invitation.workspaceId]}</Alert>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function InvitationsDialog() {
  const { closePanel } = useWorkspace();
  return (
    <Dialog title="Invitations" subtitle="Workspaces you've been invited to join" onClose={closePanel} wide>
      <InvitationsList onAccepted={closePanel} />
    </Dialog>
  );
}
