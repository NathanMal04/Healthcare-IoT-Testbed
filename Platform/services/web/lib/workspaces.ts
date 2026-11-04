import { ApiError, apiRequest } from "@/lib/api";

/**
 * owner and member contribute; a viewer can browse and download everything in
 * the workspace but change nothing. The backend enforces this on every route.
 */
export type WorkspaceRole = "owner" | "member" | "viewer";

/** The roles an owner can invite someone as. */
export type InviteRole = "member" | "viewer";

/** A workspace, with the signed-in user's role in it (GET/POST /workspaces). */
export interface Workspace {
  workspaceId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  role: WorkspaceRole;
}

/** A member as GET /workspaces/{id} returns it. email is null when it wasn't verified. */
export interface WorkspaceMember {
  userId: string;
  role: WorkspaceRole;
  email: string | null;
  joinedAt: string | null;
  invitedBy: string | null;
}

/** A pending invitation sent by the workspace; only owners receive these. */
export interface WorkspaceInvite {
  email: string;
  role: WorkspaceRole;
  invitedBy: string;
  invitedByEmail: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceDetail {
  workspace: Workspace;
  members: WorkspaceMember[];
  /** Present only when the signed-in user is an owner. */
  invites?: WorkspaceInvite[];
}

/** An invitation addressed to the signed-in user's verified email (GET /invites). */
export interface WorkspaceInvitation {
  workspaceId: string;
  workspaceName: string;
  /** The role accepting grants. */
  role: InviteRole;
  invitedBy: string;
  invitedByEmail: string | null;
  createdAt: string;
  expiresAt: string;
}

// --- API ---------------------------------------------------------------------

export async function listWorkspaces(): Promise<Workspace[]> {
  return (await apiRequest<{ workspaces: Workspace[] }>("GET", "/workspaces")).workspaces;
}

export async function createWorkspace(name: string): Promise<Workspace> {
  return (await apiRequest<{ workspace: Workspace }>("POST", "/workspaces", { body: { name } })).workspace;
}

/** The workspace, its members and, for owners, its pending invitations. */
export function getWorkspace(workspaceId: string): Promise<WorkspaceDetail> {
  return apiRequest<WorkspaceDetail>("GET", `/workspaces/${encodeURIComponent(workspaceId)}`);
}

/** Creates an in-app invitation; no email is sent. */
export async function inviteWorkspaceMember(
  workspaceId: string,
  email: string,
  role: InviteRole = "member"
): Promise<WorkspaceInvite> {
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/invites`;
  return (await apiRequest<{ invite: WorkspaceInvite }>("POST", path, { body: { email, role } })).invite;
}

/** Withdraws a pending invitation (owners only). */
export function revokeWorkspaceInvite(workspaceId: string, email: string): Promise<{ revoked: boolean }> {
  return apiRequest("POST", `/workspaces/${encodeURIComponent(workspaceId)}/invites/revoke`, { body: { email } });
}

/** Removes a member or viewer; their access ends immediately (owners only). */
export function removeWorkspaceMember(workspaceId: string, userId: string): Promise<{ removed: boolean }> {
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`;
  return apiRequest("DELETE", path);
}

export async function listMyInvitations(): Promise<WorkspaceInvitation[]> {
  return (await apiRequest<{ invites: WorkspaceInvitation[] }>("GET", "/invites")).invites;
}

// Accept and decline send no body: the backend identifies the invitee by the
// verified email in their Cognito token.

export async function acceptWorkspaceInvitation(workspaceId: string): Promise<Workspace> {
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/accept`;
  return (await apiRequest<{ workspace: Workspace }>("POST", path)).workspace;
}

export function declineWorkspaceInvitation(workspaceId: string): Promise<{ declined: boolean; workspaceId: string }> {
  return apiRequest("POST", `/workspaces/${encodeURIComponent(workspaceId)}/decline`);
}

// --- Scope -------------------------------------------------------------------

/**
 * What the dashboard is showing: the user's personal resources, or one
 * workspace's. The role is only for showing or hiding controls; the backend
 * decides what is actually allowed.
 */
export type Scope =
  | { kind: "personal" }
  | { kind: "workspace"; workspaceId: string; name: string; role: WorkspaceRole };

export const PERSONAL_SCOPE: Scope = { kind: "personal" };

export function workspaceScope(workspace: Workspace): Scope {
  return { kind: "workspace", workspaceId: workspace.workspaceId, name: workspace.name, role: workspace.role };
}

/**
 * Whether the user may change things in this scope: always in Personal, and
 * for owners and members of a workspace. False for viewers (and any role this
 * client doesn't know). Only hides controls; the backend enforces it.
 */
export function canContribute(scope: Scope): boolean {
  return scope.kind === "personal" || scope.role === "owner" || scope.role === "member";
}

/** True for a workspace the user can only view. */
export function isReadOnlyScope(scope: Scope): boolean {
  return !canContribute(scope);
}

/** The workspaceId to send to scoped endpoints, or undefined for Personal. */
export function scopeWorkspaceId(scope: Scope): string | undefined {
  return scope.kind === "workspace" ? scope.workspaceId : undefined;
}

/** Stable identity of a scope; views are keyed on it so nothing carries over between scopes. */
export function scopeKey(scope: Scope): string {
  return scope.kind === "workspace" ? `workspace:${scope.workspaceId}` : "personal";
}

// --- Errors ------------------------------------------------------------------

/**
 * A message to show for a failed workspace request. Backend 4xx errors carry
 * user-facing messages; server and network failures get the fallback.
 */
export function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 410) return "This invitation has expired.";
    if (err.status >= 500) return `${fallback}. Please try again.`;
    return err.message;
  }
  return `${fallback}. Please try again.`;
}

/** True when a workspace request failed because the workspace is no longer available to the user. */
export function isWorkspaceUnavailable(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.status === 404);
}
