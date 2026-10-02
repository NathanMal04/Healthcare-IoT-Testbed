"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { formatDate, inputClass, labelClass, primaryButton, secondaryButton } from "@/app/components/ui";

/** The workspace dialogs, opened from the nav bar and the dashboard. */
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
    <div className="mb-6 text-sm bg-amber-50 text-amber-800 px-4 py-2 rounded-lg flex items-center justify-between gap-4">
      <span>{notice}</span>
      <button type="button" onClick={dismissNotice} aria-label="Dismiss" className="text-amber-700 hover:text-amber-900">
        ✕
      </button>
    </div>
  );
}

function Dialog({
  title,
  subtitle,
  onClose,
  wide,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`w-full ${wide ? "max-w-lg" : "max-w-sm"} bg-white rounded-2xl border border-slate-100 shadow-sm p-8 max-h-[90vh] overflow-y-auto`}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-800 tracking-tight">{title}</h2>
            {subtitle && <p className="text-slate-400 text-sm mt-1">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
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
    <Dialog title="Create Workspace" subtitle="A shared space for your team's devices and firmware" onClose={close}>
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
            placeholder="Healthcare IoT Testbed"
            autoFocus
          />
        </div>
        {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex items-center gap-3 pt-2">
          <button type="button" onClick={close} disabled={submitting} className={`${secondaryButton} flex-1`}>
            Cancel
          </button>
          <button type="submit" disabled={submitting || !name.trim()} className={`${primaryButton} flex-1`}>
            {submitting ? "Creating…" : "Create Workspace"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// --- Members -------------------------------------------------------------------

function MembersDialog({ workspaceId }: { workspaceId: string }) {
  const { user } = useAuth();
  const { closePanel, reportWorkspaceUnavailable } = useWorkspace();
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
    // Invalidates the in-flight load when the dialog closes or reloads.
    const loadIds = loadIdRef;
    return () => {
      loadIds.current++;
    };
  }, [load]);

  async function invite(email: string): Promise<WorkspaceInvite> {
    const created = await inviteWorkspaceMember(workspaceId, email);
    await load();
    return created;
  }

  return (
    <Dialog title={detail?.workspace.name ?? "Workspace"} subtitle="Members and invitations" onClose={closePanel} wide>
      {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-4">{error}</p>}
      {detail ? (
        <MembersPanel detail={detail} currentUserId={user?.userId ?? null} onInvite={invite} />
      ) : (
        !error && <p className="text-sm text-slate-400">Loading…</p>
      )}
    </Dialog>
  );
}

function RoleBadge({ role }: { role: WorkspaceRole }) {
  return role === "owner" ? (
    <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">Owner</span>
  ) : (
    <span className="text-xs font-medium text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full">Member</span>
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
        <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
          Members ({detail.members.length})
        </h3>
        <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
          {detail.members.map((member) => (
            <li key={member.userId} className="px-3 py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-slate-800 truncate">
                  {member.email ?? <span className="text-slate-400">Email not verified</span>}
                  {member.userId === currentUserId && <span className="text-slate-400"> (you)</span>}
                </p>
                {member.joinedAt && <p className="text-xs text-slate-400">Joined {formatDate(member.joinedAt)}</p>}
              </div>
              <RoleBadge role={member.role} />
            </li>
          ))}
        </ul>
      </section>

      {isOwner ? (
        <>
          <section>
            <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Invite a member</h3>
            <form onSubmit={handleInvite} className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={inviting}
                placeholder="teammate@example.com"
                aria-label="Email address to invite"
                className={inputClass}
              />
              <button type="submit" disabled={inviting || !email.trim()} className={`${primaryButton} whitespace-nowrap`}>
                {inviting ? "Inviting…" : "Invite Member"}
              </button>
            </form>
            <p className="text-xs text-slate-400 mt-1.5">
              Invitations are shown in the app; no email is sent. They join as a member.
            </p>
            {inviteDone && <p className="text-xs text-emerald-700 bg-emerald-50 px-3 py-2 rounded-lg mt-2">{inviteDone}</p>}
            {inviteError && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg mt-2">{inviteError}</p>}
          </section>

          <section>
            <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Pending invitations</h3>
            {detail.invites && detail.invites.length > 0 ? (
              <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
                {detail.invites.map((invite) => (
                  <li key={invite.email} className="px-3 py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-800 truncate">{invite.email}</p>
                      <p className="text-xs text-slate-400">
                        Expires {formatDate(invite.expiresAt)}
                        {" · invited by "}
                        {invite.invitedByEmail ?? emailsById.get(invite.invitedBy) ?? "an owner"}
                      </p>
                    </div>
                    <RoleBadge role={invite.role} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">No pending invitations.</p>
            )}
          </section>
        </>
      ) : (
        <p className="text-sm text-slate-400">Only workspace owners can invite members.</p>
      )}
    </div>
  );
}

// --- Invitations for the signed-in user -------------------------------------------

function InvitationsDialog() {
  const {
    invitations,
    invitationsError,
    refreshInvitations,
    refreshWorkspaces,
    selectWorkspace,
    closePanel,
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
          closePanel();
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
    <Dialog title="Invitations" subtitle="Workspaces you've been invited to join" onClose={closePanel} wide>
      {invitationsError && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-4">{invitationsError}</p>}
      {invitations === null ? (
        !invitationsError && <p className="text-sm text-slate-400">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-slate-400">No pending invitations.</p>
      ) : (
        <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
          {shown.map((invitation) => (
            <li key={invitation.workspaceId} className="px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{invitation.workspaceName}</p>
                  <p className="text-xs text-slate-400">
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
                <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg mt-2">{errors[invitation.workspaceId]}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
