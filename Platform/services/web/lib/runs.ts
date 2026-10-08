import { apiRequest } from "@/lib/api";
import type { ArtifactType } from "@/lib/artifacts";

export type RunClass = "economy" | "standard" | "heavy";
export type RunSize = "S" | "M" | "L" | "XL";
export type RunMode = "map" | "groupBy" | "chunk" | "all";
export type GroupBy = "folder" | "stem" | "regex" | "tag";
export type RunStatus = "pending" | "queued" | "running" | "completed" | "failed" | "cancelled" | "stopped";

export type RunInputs =
  | { batchId: string }
  | { deviceId: string; type?: ArtifactType }
  | { runId: string }
  | { artifactIds: string[] }
  | { type?: ArtifactType; tag?: string };

export interface RunRequest {
  moduleId: string;
  version?: number;
  inputs: RunInputs;
  mode: RunMode;
  chunkSize?: number;
  groupBy?: {
    by: GroupBy;
    depth?: number;
    ignoreCase?: boolean;
    pattern?: string;
    tagPrefix?: string;
    requireTypes?: ArtifactType[];
    includeIncomplete?: boolean;
  };
  unitsPerJob?: number;
  class: RunClass;
  size: RunSize;
  timeoutMinutes: number;
  name?: string;
  /** Run in this workspace, on its files; absent for a Personal run. */
  workspaceId?: string;
}

export interface Estimate {
  matched: number;
  inputCount: number;
  totalBytes: number;
  notReady: { artifactId: string; name: string; status: string }[];
  notReadyCount: number;
  unitCount: number;
  childCount: number;
  sampleUnits: { key: string; files: number }[];
  unmatched: string[];
  unmatchedCount: number;
  incomplete: { key: string; missing: string[]; files: string[] }[];
  incompleteCount: number;
  duplicates: number;
  version: number;
  vcpu: number;
  memoryMiB: number;
  maxCost: number;
  expectedCost: number | null;
  budget: { monthlyLimit: number; spent: number; held: number; available: number; heavyEnabled: boolean };
}

export interface Run {
  runId: string;
  name: string;
  moduleId: string;
  moduleName: string;
  moduleVersion: number;
  inputs: Record<string, unknown>;
  mode: RunMode;
  class: RunClass;
  size: RunSize;
  inputCount: number;
  unitCount: number;
  childCount: number;
  maxCost: number;
  expectedCost?: number;
  costProvisional: number;
  unitsSucceeded: number;
  unitsFailed: number;
  outputCount: number;
  status: RunStatus;
  statusReason?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  cancelRequested?: boolean;
  /** Workspace runs only: the workspace, and the member who started it (Cognito sub). */
  workspaceId?: string;
  createdBy?: string;
  /** Run detail of a workspace run only, while the creator is still a member with a verified email. */
  createdByEmail?: string;
}

export interface RunDetail {
  run: Run;
  /** Whether the signed-in user may cancel it: its creator, or a workspace owner. */
  canCancel: boolean;
  jobs: {
    counts: Record<string, number>;
    items: {
      index: number;
      status: string;
      attempts: number;
      units: number;
      startedAt?: string;
      stoppedAt?: string;
      statusReason?: string;
      hasLog: boolean;
    }[];
  };
  failedUnits: { unitId: string; key: string; error?: string; exitCode?: number }[];
}

export const TERMINAL_STATUSES: RunStatus[] = ["completed", "failed", "cancelled", "stopped"];

export function estimateRun(request: RunRequest): Promise<Estimate> {
  return apiRequest("POST", "/runs/estimate", { body: request });
}

export async function startRun(request: RunRequest): Promise<Run> {
  return (await apiRequest<{ run: Run }>("POST", "/runs", { body: request })).run;
}

/** Personal runs, or a workspace's runs when workspaceId is given. Newest first. */
export async function listRuns(workspaceId?: string): Promise<Run[]> {
  return (await apiRequest<{ runs: Run[] }>("GET", "/runs", { query: { workspaceId } })).runs;
}

export function getRun(runId: string): Promise<RunDetail> {
  return apiRequest("GET", `/runs/${encodeURIComponent(runId)}`);
}

export function cancelRun(runId: string): Promise<{ status: string }> {
  return apiRequest("POST", `/runs/${encodeURIComponent(runId)}/cancel`);
}

export function getJobLog(runId: string, index: number): Promise<{ lines: string[]; note?: string }> {
  return apiRequest("GET", `/runs/${encodeURIComponent(runId)}/children/${index}/log`);
}

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** True when the run belongs to the given scope (workspaceId undefined = Personal). */
export function runInScope(run: Pick<Run, "workspaceId">, workspaceId: string | undefined): boolean {
  return (run.workspaceId ?? null) === (workspaceId ?? null);
}

/** Hand-picked artifacts travel from the Artifacts page to the run form here. */
export const RUN_SELECTION_KEY = "runSelection";

/** The stored selection: the artifact ids and the scope (scopeKey) they were picked in. */
export function serializeRunSelection(scopeKey: string, artifactIds: string[]): string {
  return JSON.stringify({ scope: scopeKey, artifactIds });
}

/**
 * The selected artifact ids, if they were picked in `scopeKey`; otherwise
 * none, so files from another workspace (or Personal) are never submitted.
 */
export function parseRunSelection(raw: string | null, scopeKey: string): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const { scope, artifactIds } = value as { scope?: unknown; artifactIds?: unknown };
    if (scope !== scopeKey || !Array.isArray(artifactIds)) return [];
    return artifactIds.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}
