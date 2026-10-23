// Pure helpers for the dashboard and device pages: counts and summaries
// derived from data the pages already load. No history is invented here.

import {
  REVERSE_ENGINEERING_STATUSES,
  toReverseEngineeringStatus,
  type ReverseEngineeringStatus,
} from "@/lib/reverseEngineering";
import { SEVERITIES, type CveSummary, type Severity } from "@/lib/cves";

/**
 * A count from one page of a paged list. When more pages exist the true
 * total is unknown, so it reads "N+" rather than a number that looks exact.
 */
export function countLabel(count: number, hasMore: boolean): string {
  return hasMore ? `${count}+` : String(count);
}

export interface ReProgress {
  total: number;
  counts: Record<ReverseEngineeringStatus, number>;
  /** Whole-number percentages that add up to 100 (0 when there is nothing). */
  percents: Record<ReverseEngineeringStatus, number>;
}

/** Reverse-engineering progress across items with a reverseEngineeringStatus (devices). */
export function reProgress(items: { reverseEngineeringStatus?: string }[]): ReProgress {
  const counts = { not_started: 0, in_progress: 0, complete: 0 } as Record<ReverseEngineeringStatus, number>;
  for (const item of items) counts[toReverseEngineeringStatus(item.reverseEngineeringStatus)]++;
  const total = items.length;
  const percents = { not_started: 0, in_progress: 0, complete: 0 } as Record<ReverseEngineeringStatus, number>;
  if (total > 0) {
    // Largest-remainder rounding, so the parts always sum to exactly 100.
    const exact = REVERSE_ENGINEERING_STATUSES.map((s) => ({ s, value: (counts[s] / total) * 100 }));
    let assigned = 0;
    for (const { s, value } of exact) {
      percents[s] = Math.floor(value);
      assigned += percents[s];
    }
    const byRemainder = [...exact].sort((a, b) => b.value - Math.floor(b.value) - (a.value - Math.floor(a.value)));
    for (let i = 0; i < 100 - assigned; i++) percents[byRemainder[i % byRemainder.length].s]++;
  }
  return { total, counts, percents };
}

export function severityCounts(cves: Pick<CveSummary, "severity">[]): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const cve of cves) if (cve.severity in counts) counts[cve.severity]++;
  return counts;
}

/** The most recently updated CVEs, newest first. */
export function recentCves<T extends Pick<CveSummary, "updatedAt">>(cves: T[], limit = 5): T[] {
  return [...cves]
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .slice(0, limit);
}

/** The CVEs linked to one device. */
export function cvesForDevice<T extends Pick<CveSummary, "deviceIds">>(cves: T[], deviceId: string): T[] {
  return cves.filter((cve) => cve.deviceIds.includes(deviceId));
}

/** Devices whose name contains the query (case-insensitive) and, if given, have the RE status. */
export function filterDevices<T extends { name: string; reverseEngineeringStatus?: string }>(
  devices: T[],
  query: string,
  reStatus: ReverseEngineeringStatus | ""
): T[] {
  const needle = query.trim().toLowerCase();
  return devices.filter(
    (d) =>
      (!needle || d.name.toLowerCase().includes(needle)) &&
      (!reStatus || toReverseEngineeringStatus(d.reverseEngineeringStatus) === reStatus)
  );
}
