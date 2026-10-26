import { apiRequest } from "@/lib/api";
import type { NetworkStatus } from "@/lib/runs";

export type SessionSize = "S" | "M" | "L";
export type SessionStatus = "waiting" | "launching" | "running" | "stopping" | "stopped" | "failed";

export const ACTIVE_SESSION_STATUSES: SessionStatus[] = ["waiting", "launching", "running", "stopping"];

export interface Session {
  sessionId: string;
  name: string;
  envId: string;
  envName: string;
  envVersion: number;
  size: SessionSize;
  vcpu: number;
  memoryMiB: number;
  maxSeconds: number;
  maxCost: number;
  held: number;
  costProvisional: number;
  inputCount: number;
  artifactIds: string[];
  inputsWorkspaceId?: string;
  status: SessionStatus;
  statusReason?: string;
  stopReason?: string;
  createdAt: string;
  launchedAt?: string;
  startedAt?: string;
  endedAt?: string;
  /** JupyterLab answers the load balancer's health check. */
  ready: boolean;
}

export interface SessionSizeInfo {
  vcpu: number;
  memoryMiB: number;
  hourly: number;
}

export interface SessionList {
  sessions: Session[];
  sizes: Record<SessionSize, SessionSizeInfo>;
  limits: { maxHours: number; maxFiles: number; maxActive: number; idleMinutes: number };
  network: NetworkStatus;
}

export interface SessionDetail {
  session: Session;
  network: NetworkStatus;
  /** Once JupyterLab is reachable: its path on this site, with the session's token. */
  url?: string;
  token?: string;
}

export interface StartSessionRequest {
  envId: string;
  envVersion?: number;
  artifactIds: string[];
  workspaceId?: string;
  size: SessionSize;
  maxHours: number;
  name?: string;
}

export function listSessions(): Promise<SessionList> {
  return apiRequest("GET", "/sessions");
}

export async function startSession(request: StartSessionRequest): Promise<Session> {
  return (await apiRequest<{ session: Session }>("POST", "/sessions", { body: request })).session;
}

export function getSession(sessionId: string): Promise<SessionDetail> {
  return apiRequest("GET", `/sessions/${encodeURIComponent(sessionId)}`);
}

export function stopSession(sessionId: string): Promise<{ status: string }> {
  return apiRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/stop`);
}

export function getSessionLog(sessionId: string): Promise<{ lines: string[]; note?: string }> {
  return apiRequest("GET", `/sessions/${encodeURIComponent(sessionId)}/log`);
}

/** Hand-picked artifacts travel from the Artifacts page to the new-notebook form here. */
export const NOTEBOOK_SELECTION_KEY = "notebookSelection";

/** Cost so far of an open session (the ledger only has it once it stops). */
export function sessionCostSoFar(session: Session, hourly: number, now: number = Date.now()): number {
  if (session.status !== "running" && session.status !== "stopping") return session.costProvisional;
  const started = Date.parse(session.startedAt ?? session.launchedAt ?? session.createdAt);
  return Math.max(0, (now - started) / 3_600_000) * hourly;
}

// --- JupyterLab's own API (same site, with the session's token) ------------------------

export interface NotebookFile {
  name: string;
  path: string;
  lastModified: string;
}

function jupyterHeaders(token: string): HeadersInit {
  return { Authorization: `token ${token}` };
}

/** Notebooks under /work/notebooks in a running session. */
export async function listSessionNotebooks(sessionId: string, token: string, dir = "notebooks"): Promise<NotebookFile[]> {
  const response = await fetch(`/s/${sessionId}/api/contents/${dir}?content=1`, { headers: jupyterHeaders(token) });
  if (!response.ok) throw new Error(`Couldn't list the session's notebooks (${response.status})`);
  const listing = (await response.json()) as { content: { name: string; path: string; type: string; last_modified: string }[] };
  const found: NotebookFile[] = [];
  for (const entry of listing.content) {
    if (entry.type === "notebook") found.push({ name: entry.name, path: entry.path, lastModified: entry.last_modified });
    else if (entry.type === "directory" && !entry.name.startsWith(".")) {
      found.push(...(await listSessionNotebooks(sessionId, token, entry.path)));
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readSessionNotebook(sessionId: string, token: string, path: string): Promise<unknown> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`/s/${sessionId}/api/contents/${encoded}?content=1&type=notebook`, {
    headers: jupyterHeaders(token),
  });
  if (!response.ok) throw new Error(`Couldn't read ${path} (${response.status})`);
  return ((await response.json()) as { content: unknown }).content;
}
