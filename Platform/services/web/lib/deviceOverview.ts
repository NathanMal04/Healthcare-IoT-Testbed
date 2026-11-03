// The device Overview's figures, worked out from what the existing APIs
// return. Pure, so every number on the Overview is tested apart from the
// page. Nothing here estimates or invents a value: a count from one page of
// a paged list says so, and a missing timestamp or name stays missing.

import type { Artifact } from "@/lib/artifacts";
import { SEVERITIES, type CveSummary, type Severity } from "@/lib/cves";
import type { ImageArtifact } from "@/lib/images";
import type { Notebook } from "@/lib/reNotebook";
import { REVERSE_ENGINEERING_STATUSES, toReverseEngineeringStatus, type ReverseEngineeringStatus } from "@/lib/reverseEngineering";

// --- Counts ----------------------------------------------------------------------

/**
 * A count, and whether it is the whole total. From the first page of a paged
 * list with more pages the true total is unknown: it is at least `value`.
 */
export interface Count {
  value: number;
  exact: boolean;
}

/** "12", or "12+" when there may be more. */
export function countText(count: Count): string {
  return count.exact ? String(count.value) : `${count.value}+`;
}

/** The same for screen readers and tooltips: "12", or "at least 12". */
export function countDescription(count: Count): string {
  return count.exact ? String(count.value) : `at least ${count.value}`;
}

/** The count of a first page: exact unless the list has more pages. */
export function pageCount(items: unknown[], nextToken?: string | null): Count {
  return { value: items.length, exact: !nextToken };
}

/**
 * The device's files other than firmware and images (binaries, captures,
 * logs, kernel modules, reports, other), from the first page of its
 * artifact list, which lists every type together. Firmware and images have
 * their own counts. With more pages this is a lower bound.
 */
export function otherFilesCount(page: { artifacts: Pick<Artifact, "type">[]; nextToken?: string | null }): Count {
  const others = page.artifacts.filter((a) => a.type !== "firmware" && a.type !== "image");
  return { value: others.length, exact: !page.nextToken };
}

// --- Firmware --------------------------------------------------------------------

export interface FirmwareBreakdown {
  total: number;
  /** Firmware versions by reverse-engineering status (records without one haven't been started). */
  counts: Record<ReverseEngineeringStatus, number>;
  /** Versions whose upload isn't ready (pending, verifying or failed). */
  notReady: number;
}

export function firmwareBreakdown(
  firmware: Pick<Artifact, "status" | "reverseEngineeringStatus">[]
): FirmwareBreakdown {
  const counts = Object.fromEntries(REVERSE_ENGINEERING_STATUSES.map((s) => [s, 0])) as Record<ReverseEngineeringStatus, number>;
  let notReady = 0;
  for (const item of firmware) {
    counts[toReverseEngineeringStatus(item.reverseEngineeringStatus)]++;
    if (item.status !== "ready") notReady++;
  }
  return { total: firmware.length, counts, notReady };
}

// --- Vulnerabilities -------------------------------------------------------------

/** How many CVEs of each severity, most severe first (every severity listed, zeros included). */
export function severityDistribution(cves: Pick<CveSummary, "severity">[]): { severity: Severity; count: number }[] {
  return SEVERITIES.map((severity) => ({ severity, count: cves.filter((c) => c.severity === severity).length }));
}

/**
 * The CVEs to show first: most severe, then highest CVSS score (a CVE
 * without one after those with one), then most recently updated.
 */
export function topCves<T extends Pick<CveSummary, "severity" | "cvssScore" | "updatedAt">>(cves: T[], limit = 5): T[] {
  const rank = (s: string) => {
    const i = SEVERITIES.indexOf(s as Severity);
    return i === -1 ? SEVERITIES.length : i;
  };
  return [...cves]
    .sort(
      (a, b) =>
        rank(a.severity) - rank(b.severity) ||
        (b.cvssScore ?? -1) - (a.cvssScore ?? -1) ||
        (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
    )
    .slice(0, limit);
}

// --- RE Notebook -----------------------------------------------------------------

export interface RecentEntry {
  entryId: string;
  sectionId: string;
  sectionTitle: string;
  title: string;
  /** When it was last changed, if the notebook says. */
  editedAt: string | null;
  /** Who made that change, if the notebook names them. */
  editedBy: string | null;
}

export interface NotebookSummary {
  sections: number;
  entries: number;
  /** Most recently changed first. */
  recent: RecentEntry[];
}

/**
 * Section and entry counts, and the most recently changed entries. An
 * entry's last change is its latest content save, else its latest rename or
 * move, else its creation, each with the name recorded for that change.
 */
export function notebookSummary(notebook: Pick<Notebook, "sections">, limit = 5): NotebookSummary {
  const all: RecentEntry[] = [];
  for (const section of notebook.sections) {
    for (const entry of section.entries) {
      const candidates: [string | null, string | null][] = [
        [entry.contentUpdatedAt, entry.contentUpdatedByName],
        [entry.updatedAt, entry.updatedByName],
        [entry.createdAt, entry.createdByName],
      ];
      let latest: [string | null, string | null] = [null, null];
      for (const candidate of candidates) {
        const time = Date.parse(candidate[0] ?? "");
        if (Number.isNaN(time)) continue;
        if (latest[0] === null || time > Date.parse(latest[0])) latest = candidate;
      }
      all.push({
        entryId: entry.entryId,
        sectionId: section.sectionId,
        sectionTitle: section.title,
        title: entry.title,
        editedAt: latest[0],
        editedBy: latest[0] ? latest[1] || null : null,
      });
    }
  }
  const time = (e: RecentEntry) => (e.editedAt ? Date.parse(e.editedAt) : -Infinity);
  return {
    sections: notebook.sections.length,
    entries: all.length,
    recent: [...all].sort((a, b) => time(b) - time(a)).slice(0, limit),
  };
}

// --- Images ----------------------------------------------------------------------

/** The images to preview: the newest first (the list's own order), at most `limit`. */
export function previewImages(images: ImageArtifact[], limit = 4): ImageArtifact[] {
  return images.slice(0, limit);
}
