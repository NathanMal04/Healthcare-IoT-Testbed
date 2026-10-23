"use client";

import { useEffect, useRef, useState } from "react";
import { getDevices, type Device } from "@/lib/devices";
import { listArtifacts, type Artifact } from "@/lib/artifacts";
import { listCves, type CveSummary } from "@/lib/cves";
import { getWorkspace, type Workspace, type WorkspaceMember } from "@/lib/workspaces";

/** undefined while loading, null when the request failed. */
export type Loaded<T> = T | null | undefined;

/** What one scope (Personal or a workspace) holds, read through the existing list endpoints. */
export interface ScopeResources {
  /** Workspaces only; Personal has no member list. */
  members: Loaded<WorkspaceMember[]>;
  devices: Loaded<Device[]>;
  /** The latest page of firmware; hasMore means the true count is higher. */
  firmware: Loaded<{ items: Artifact[]; hasMore: boolean }>;
  cves: Loaded<CveSummary[]>;
}

export const PERSONAL_KEY = "personal";

// The same page size the dashboard uses for firmware.
const FIRMWARE_PAGE = 100;

const LOADING: ScopeResources = { members: undefined, devices: undefined, firmware: undefined, cves: undefined };

function settled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

async function loadScope(workspaceId: string | undefined): Promise<ScopeResources> {
  const [members, devices, firmware, cves] = await Promise.allSettled([
    workspaceId ? getWorkspace(workspaceId).then((d) => d.members) : Promise.resolve(undefined),
    getDevices(workspaceId),
    listArtifacts({ type: "firmware", workspaceId, limit: FIRMWARE_PAGE }).then((page) => ({
      items: page.artifacts,
      hasMore: !!page.nextToken,
    })),
    listCves(workspaceId),
  ]);
  return {
    members: workspaceId ? settled(members) ?? null : undefined,
    devices: settled(devices),
    firmware: settled(firmware),
    cves: settled(cves),
  };
}

/**
 * Members, devices, firmware and CVEs for Personal and each of the user's
 * workspaces, for the cards, summary figures and the workspace tabs. Each
 * scope is loaded once per visit; a workspace that newly appears (created,
 * or an invitation accepted) is loaded when it does. Failures only blank
 * that figure: this is read-only decoration over the existing endpoints.
 */
export function useWorkspaceResources(workspaces: Workspace[] | null): Record<string, ScopeResources> {
  const [resources, setResources] = useState<Record<string, ScopeResources>>({});
  const started = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ids = workspaces?.map((w) => w.workspaceId).join("\n") ?? "";

  useEffect(() => {
    const keys = [PERSONAL_KEY, ...(ids ? ids.split("\n") : [])];
    for (const key of keys) {
      if (started.current.has(key)) continue;
      started.current.add(key);
      setResources((current) => ({ ...current, [key]: LOADING }));
      void loadScope(key === PERSONAL_KEY ? undefined : key).then((loaded) => {
        if (mounted.current) setResources((current) => ({ ...current, [key]: loaded }));
      });
    }
  }, [ids]);

  return resources;
}

/** A firmware count as text: "100+" when more pages exist. */
export function firmwareCount(firmware: Loaded<{ items: Artifact[]; hasMore: boolean }>): string | null {
  if (!firmware) return null;
  return firmware.hasMore ? `${firmware.items.length}+` : String(firmware.items.length);
}
