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
}

export interface RunDetail {
  run: Run;
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

export async function listRuns(): Promise<Run[]> {
  return (await apiRequest<{ runs: Run[] }>("GET", "/runs")).runs;
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

/** Hand-picked artifacts travel from the Artifacts page to the run form here. */
export const RUN_SELECTION_KEY = "runSelection";
