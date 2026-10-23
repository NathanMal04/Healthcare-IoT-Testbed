// Pure helpers for the Workspaces page: searching, sorting and the summary
// figures. Everything is derived from data the page already loads through the
// existing workspace, device, firmware and CVE endpoints; nothing is invented.

import type { Workspace, WorkspaceMember } from "@/lib/workspaces";

export type WorkspaceSort = "updated" | "created" | "name" | "role";

export const WORKSPACE_SORT_LABELS: Record<WorkspaceSort, string> = {
  updated: "Recently updated",
  created: "Recently created",
  name: "Name (A–Z)",
  role: "Owned first",
};

function time(value: string): number {
  return Date.parse(value) || 0;
}

/** Workspaces whose name contains the query (case-insensitive), in the chosen order. */
export function filterAndSortWorkspaces(workspaces: Workspace[], query: string, sort: WorkspaceSort): Workspace[] {
  const needle = query.trim().toLowerCase();
  const byName = (a: Workspace, b: Workspace) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const compare: Record<WorkspaceSort, (a: Workspace, b: Workspace) => number> = {
    updated: (a, b) => time(b.updatedAt) - time(a.updatedAt) || byName(a, b),
    created: (a, b) => time(b.createdAt) - time(a.createdAt) || byName(a, b),
    name: byName,
    role: (a, b) => (a.role === b.role ? 0 : a.role === "owner" ? -1 : 1) || byName(a, b),
  };
  return workspaces.filter((w) => !needle || w.name.toLowerCase().includes(needle)).sort(compare[sort]);
}

/** True when the Personal card matches the search. */
export function personalMatches(query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || "personal".includes(needle);
}

/** One figure across workspaces: its value, whether some are still loading, and whether some failed. */
export interface SummaryFigure {
  value: number;
  loading: boolean;
  incomplete: boolean;
}

/** What is known about one workspace for the summary: undefined while loading, null when it failed. */
export interface WorkspaceCounts {
  members: WorkspaceMember[] | null | undefined;
  devices: number | null | undefined;
  cves: number | null | undefined;
}

function sum(values: (number | null | undefined)[]): SummaryFigure {
  let value = 0;
  for (const v of values) if (typeof v === "number") value += v;
  return {
    value,
    loading: values.some((v) => v === undefined),
    incomplete: values.some((v) => v === null),
  };
}

/**
 * Members are counted once each across workspaces (by userId), so someone in
 * two of your workspaces is one collaborator, not two.
 */
export function summarizeWorkspaces(counts: WorkspaceCounts[]): {
  members: SummaryFigure;
  devices: SummaryFigure;
  cves: SummaryFigure;
} {
  const userIds = new Set<string>();
  for (const c of counts) for (const m of c.members ?? []) userIds.add(m.userId);
  return {
    members: {
      value: userIds.size,
      loading: counts.some((c) => c.members === undefined),
      incomplete: counts.some((c) => c.members === null),
    },
    devices: sum(counts.map((c) => c.devices)),
    cves: sum(counts.map((c) => c.cves)),
  };
}
