"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Inbox, UserPlus } from "lucide-react";
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
  type WorkspaceRole,
} from "@/lib/workspaces";
import { ApiError } from "@/lib/api";
import {
  Alert,
  Badge,
  Dialog,
  EmptyState,
  LoadingState,
  formatDate,
  initials,
  inputClass,
  labelClass,
  primaryButton,
  secondaryButton,
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
    <Dialog title="Create workspace" subtitle="A shared space for your team's devices and firmware" onClose={close}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="workspace-name">
            Workspace name
          </label>
          <input
            id="workspace-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            maxLength={100}
            className={inputClass}
            placeholder="Infusion pump research"
            autoFocus
          />
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex items-center gap-3 pt-2">
          <button type="button" onClick={close} disabled={submitting} className={`${secondaryButton} flex-1`}>
            Cancel
          </button>
          <button type="submit" disabled={submitting || !name.trim()} className={`${primaryButton} flex-1`}>
            {submitting ? "Creating…" : "Create workspace"}
          </button>
        </div>
      </form>
    </Dialog>
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

function Avatar({ email }: { email: string | null }) {
  return (
    <span className="h-8 w-8 shrink-0 rounded-full bg-navy-800 text-white text-xs font-semibold flex items-center justify-center">
      {initials(email)}
    </span>
  );
}

/**
 * Members, and for owners the invite form and pending invitations. Whether
 * the user is an owner comes from the workspace the backend returned, which
 * also re-checks it on every invitation.
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
  const emailsById = new Map(detail.members.map((m) => [m.userId, m.email]));

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
    <div className="space-y-6">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
          Members ({detail.members.length})
        </h3>
        <ul className="divide-y divide-line border border-line rounded-lg">
          {detail.members.map((member) => (
            <li key={member.userId} className="px-3 py-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar email={member.email} />
                <div className="min-w-0">
                  <p className="text-sm text-slate-800 truncate">
                    {member.email ?? <span className="text-slate-400">Email not verified</span>}
                    {member.userId === currentUserId && <span className="text-slate-400"> (you)</span>}
                  </p>
                  {member.joinedAt && <p className="text-xs text-slate-500">Joined {formatDate(member.joinedAt)}</p>}
                </div>
              </div>
              <RoleBadge role={member.role} />
            </li>
          ))}
        </ul>
      </section>

      {isOwner ? (
        <>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Invite a member</h3>
            <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={inviting}
                placeholder="teammate@example.com"
                aria-label="Email address to invite"
                className={inputClass}
              />
              <button type="submit" disabled={inviting || !email.trim()} className={primaryButton}>
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                {inviting ? "Inviting…" : "Invite member"}
              </button>
            </form>
            <p className="text-xs text-slate-500 mt-1.5">
              Invitations are shown in the app; no email is sent. They join as a member.
            </p>
            {inviteDone && <Alert tone="success" className="mt-2">{inviteDone}</Alert>}
            {inviteError && <Alert tone="error" className="mt-2">{inviteError}</Alert>}
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Pending invitations</h3>
            {detail.invites && detail.invites.length > 0 ? (
              <ul className="divide-y divide-line border border-line rounded-lg">
                {detail.invites.map((invite) => (
                  <li key={invite.email} className="px-3 py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-800 truncate">{invite.email}</p>
                      <p className="text-xs text-slate-500">
                        Expires {formatDate(invite.expiresAt)}
                        {" · invited by "}
                        {invite.invitedByEmail ?? emailsById.get(invite.invitedBy) ?? "an owner"}
                      </p>
                    </div>
                    <Badge tone="warning">Pending</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">No pending invitations.</p>
            )}
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
        <EmptyState icon={Inbox} title="No pending invitations" className="py-8" />
      ) : (
        <ul className="divide-y divide-line border border-line rounded-lg">
          {shown.map((invitation) => (
            <li key={invitation.workspaceId} className="px-3 py-3">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{invitation.workspaceName}</p>
                  <p className="text-xs text-slate-500">
                    Invited by {invitation.invitedByEmail ?? "a workspace owner"} · Expires{" "}
                    {formatDate(invitation.expiresAt)}
                  </p>
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
