"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  PERSONAL_SCOPE,
  describeError,
  listMyInvitations,
  listWorkspaces,
  workspaceScope,
  type Scope,
  type Workspace,
  type WorkspaceInvitation,
} from "@/lib/workspaces";

export type WorkspacePanel = "create" | "members" | "invitations";

// The selected workspace's id, per user, so it survives a reload. Only the id
// is kept: the name and role always come from a fresh GET /workspaces.
const SELECTED_WORKSPACE_KEY = "workspace:selected:";

function readSelectedWorkspaceId(userId: string): string | null {
  try {
    return localStorage.getItem(SELECTED_WORKSPACE_KEY + userId);
  } catch {
    return null; // storage unavailable (private mode, blocked site data)
  }
}

function writeSelectedWorkspaceId(userId: string, workspaceId: string | null) {
  try {
    if (workspaceId) localStorage.setItem(SELECTED_WORKSPACE_KEY + userId, workspaceId);
    else localStorage.removeItem(SELECTED_WORKSPACE_KEY + userId);
  } catch {
    // storage unavailable; the selection just won't survive a reload
  }
}

interface WorkspaceContextValue {
  /** Personal (the default) or the selected workspace; the workspace's id is saved per user. */
  scope: Scope;
  /**
   * False while the signed-in user's saved workspace is being restored. Scoped
   * views wait for it so nothing loads for Personal first.
   */
  scopeReady: boolean;
  selectPersonal: () => void;
  selectWorkspace: (workspace: Workspace) => void;

  workspaces: Workspace[] | null;
  workspacesError: string | null;
  refreshWorkspaces: () => Promise<Workspace[] | null>;

  /** Invitations addressed to the signed-in user. */
  invitations: WorkspaceInvitation[] | null;
  invitationsError: string | null;
  refreshInvitations: () => Promise<void>;

  /**
   * For a scoped request that came back 403/404: re-reads the workspace list
   * and returns to Personal if the selected workspace is no longer in it.
   */
  reportWorkspaceUnavailable: () => void;
  notice: string | null;
  dismissNotice: () => void;

  panel: WorkspacePanel | null;
  openPanel: (panel: WorkspacePanel) => void;
  closePanel: () => void;

  /** True while an upload is running; the scope can't change until it ends. */
  scopeLocked: boolean;
  lockScope: () => () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const userId = user?.userId ?? null;

  const [scope, setScope] = useState<Scope>(PERSONAL_SCOPE);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[] | null>(null);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<WorkspacePanel | null>(null);
  const [locks, setLocks] = useState(0);
  // The user whose initial scope has been settled: the saved workspace
  // restored, or Personal. Derived during render, so a newly signed-in user is
  // never "ready" with a scope that hasn't been resolved for them.
  const [resolvedUserId, setResolvedUserId] = useState<string | null>(null);
  const resolvedUserIdRef = useRef<string | null>(null);
  const scopeReady = !userId || resolvedUserId === userId;

  // Responses to superseded requests (and to a previous user's) are ignored.
  const workspacesLoadId = useRef(0);
  const invitationsLoadId = useRef(0);
  const scopeRef = useRef<Scope>(scope);
  scopeRef.current = scope;

  useEffect(() => {
    workspacesLoadId.current++;
    invitationsLoadId.current++;
    resolvedUserIdRef.current = null;
    setResolvedUserId(null);
    setScope(PERSONAL_SCOPE);
    setWorkspaces(null);
    setWorkspacesError(null);
    setInvitations(null);
    setInvitationsError(null);
    setNotice(null);
    setPanel(null);
  }, [userId]);

  const markResolved = useCallback((id: string) => {
    resolvedUserIdRef.current = id;
    setResolvedUserId(id);
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    if (!userId) return null;
    const loadId = ++workspacesLoadId.current;
    try {
      const list = await listWorkspaces();
      if (loadId !== workspacesLoadId.current) return null;
      setWorkspaces(list);
      setWorkspacesError(null);

      // The first load for this user restores their saved workspace, if they
      // still belong to it.
      if (resolvedUserIdRef.current !== userId) {
        const savedId = readSelectedWorkspaceId(userId);
        const saved = savedId ? list.find((w) => w.workspaceId === savedId) : undefined;
        if (saved) setScope(workspaceScope(saved));
        else if (savedId) writeSelectedWorkspaceId(userId, null);
        markResolved(userId);
        return list;
      }

      // Keep the selected workspace's name and role current, and leave it if
      // the user no longer belongs to it.
      const current = scopeRef.current;
      if (current.kind === "workspace") {
        const fresh = list.find((w) => w.workspaceId === current.workspaceId);
        if (!fresh) {
          writeSelectedWorkspaceId(userId, null);
          setScope(PERSONAL_SCOPE);
          setPanel(null);
          setNotice(`You no longer have access to ${current.name}. Showing Personal.`);
        } else if (fresh.name !== current.name || fresh.role !== current.role) {
          setScope(workspaceScope(fresh));
        }
      }
      return list;
    } catch (err) {
      if (loadId === workspacesLoadId.current) {
        setWorkspacesError(describeError(err, "Couldn't load workspaces"));
        // Stay on Personal for now, but keep the saved workspace so the next
        // load can restore it.
        if (resolvedUserIdRef.current !== userId) markResolved(userId);
      }
      return null;
    }
  }, [userId, markResolved]);

  const refreshInvitations = useCallback(async () => {
    if (!userId) return;
    const loadId = ++invitationsLoadId.current;
    try {
      const list = await listMyInvitations();
      if (loadId !== invitationsLoadId.current) return;
      setInvitations(list);
      setInvitationsError(null);
    } catch (err) {
      if (loadId === invitationsLoadId.current) setInvitationsError(describeError(err, "Couldn't load invitations"));
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void refreshWorkspaces();
    void refreshInvitations();
  }, [userId, refreshWorkspaces, refreshInvitations]);

  const scopeLocked = locks > 0;

  // An explicit choice also settles the initial scope, so a restore still in
  // flight can't override it.
  const selectPersonal = useCallback(() => {
    if (scopeLocked) return;
    setScope(PERSONAL_SCOPE);
    setNotice(null);
    if (userId) {
      writeSelectedWorkspaceId(userId, null);
      markResolved(userId);
    }
  }, [scopeLocked, userId, markResolved]);

  const selectWorkspace = useCallback(
    (workspace: Workspace) => {
      if (scopeLocked) return;
      setScope(workspaceScope(workspace));
      setNotice(null);
      if (userId) {
        writeSelectedWorkspaceId(userId, workspace.workspaceId);
        markResolved(userId);
      }
    },
    [scopeLocked, userId, markResolved]
  );

  const reportWorkspaceUnavailable = useCallback(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  const lockScope = useCallback(() => {
    setLocks((n) => n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setLocks((n) => n - 1);
    };
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      scope,
      scopeReady,
      selectPersonal,
      selectWorkspace,
      workspaces,
      workspacesError,
      refreshWorkspaces,
      invitations,
      invitationsError,
      refreshInvitations,
      reportWorkspaceUnavailable,
      notice,
      dismissNotice: () => setNotice(null),
      panel,
      openPanel: setPanel,
      closePanel: () => setPanel(null),
      scopeLocked,
      lockScope,
    }),
    [
      scope, scopeReady, selectPersonal, selectWorkspace, workspaces, workspacesError, refreshWorkspaces, invitations,
      invitationsError, refreshInvitations, reportWorkspaceUnavailable, notice, panel, scopeLocked, lockScope,
    ]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}

/** Keeps the scope from changing while `active` (e.g. during an upload). */
export function useScopeLock(active: boolean) {
  const { lockScope } = useWorkspace();
  useEffect(() => (active ? lockScope() : undefined), [active, lockScope]);
}
