"use client";

import { useEffect, useState } from "react";
import { listDeviceArtifacts } from "@/lib/artifacts";
import { pageCount, type Count } from "@/lib/deviceOverview";
import { OVERVIEW_ARTIFACT_PAGE } from "@/app/components/device/useOverviewData";

/** At most this many device artifact lists are requested at once. */
export const ARTIFACT_COUNT_CONCURRENCY = 4;

export interface DeviceArtifactCounts {
  /** Each device's file count, once its first page has loaded. */
  counts: ReadonlyMap<string, Count>;
  /** Devices whose list couldn't be read. */
  failed: ReadonlySet<string>;
}

/**
 * How many files (firmware, images and other artifacts) are linked to each
 * device: the first page of GET /devices/{id}/artifacts, the same page the
 * device's Overview counts, so the two always agree ("N", or "N+" when the
 * device has more). Each request is checked against the device's own scope
 * by the API, as on the device page.
 *
 * Requested once per `reloadKey` (the page bumps it after each device load),
 * never on re-renders or view switches. A refresh keeps the previous counts
 * on screen until the new ones arrive.
 */
export function useDeviceArtifactCounts(deviceIds: string[] | null, reloadKey: number): DeviceArtifactCounts {
  const [counts, setCounts] = useState<ReadonlyMap<string, Count>>(() => new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const key = deviceIds === null ? null : deviceIds.join(",");

  useEffect(() => {
    if (key === null) return;
    const ids = key ? key.split(",") : [];
    const wanted = new Set(ids);
    let cancelled = false;

    // Devices no longer listed drop out; the others keep their last count.
    setCounts((current) => new Map([...current].filter(([id]) => wanted.has(id))));
    setFailed(new Set());

    let next = 0;
    async function worker() {
      while (!cancelled && next < ids.length) {
        const deviceId = ids[next++];
        try {
          const page = await listDeviceArtifacts(deviceId, { limit: OVERVIEW_ARTIFACT_PAGE });
          if (cancelled) return;
          setCounts((current) => new Map(current).set(deviceId, pageCount(page.artifacts, page.nextToken)));
        } catch {
          if (cancelled) return;
          setCounts((current) => {
            if (!current.has(deviceId)) return current;
            const remaining = new Map(current);
            remaining.delete(deviceId);
            return remaining;
          });
          setFailed((current) => new Set(current).add(deviceId));
        }
      }
    }
    for (let i = 0; i < Math.min(ARTIFACT_COUNT_CONCURRENCY, ids.length); i++) void worker();

    return () => {
      cancelled = true;
    };
  }, [key, reloadKey]);

  return { counts, failed };
}
