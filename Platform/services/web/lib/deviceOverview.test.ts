import { describe, expect, it } from "vitest";
import {
  countDescription,
  countText,
  firmwareBreakdown,
  notebookSummary,
  otherFilesCount,
  pageCount,
  previewImages,
  severityDistribution,
  topCves,
} from "./deviceOverview";
import type { NotebookEntry, NotebookSection } from "./reNotebook";
import type { ImageArtifact } from "./images";

describe("counts", () => {
  it("are exact for a whole list and lower bounds for one page of more", () => {
    expect(pageCount([1, 2, 3])).toEqual({ value: 3, exact: true });
    expect(pageCount([1, 2, 3], "next")).toEqual({ value: 3, exact: false });
    expect(pageCount([], null)).toEqual({ value: 0, exact: true });
    expect(countText({ value: 12, exact: true })).toBe("12");
    expect(countText({ value: 100, exact: false })).toBe("100+");
    expect(countDescription({ value: 12, exact: true })).toBe("12");
    expect(countDescription({ value: 100, exact: false })).toBe("at least 100");
  });

  it("count other files without firmware or images, partial when the list has more pages", () => {
    const types = ["firmware", "image", "binary", "pcap", "log", "kernel_module", "report", "other", "image"] as const;
    const artifacts = types.map((type) => ({ type }));
    expect(otherFilesCount({ artifacts })).toEqual({ value: 6, exact: true });
    expect(otherFilesCount({ artifacts, nextToken: "t" })).toEqual({ value: 6, exact: false });
    expect(otherFilesCount({ artifacts: [{ type: "firmware" }, { type: "image" }] })).toEqual({ value: 0, exact: true });
  });
});

describe("firmware breakdown", () => {
  it("counts versions by reverse-engineering status, unset ones as not started", () => {
    const breakdown = firmwareBreakdown([
      { status: "ready", reverseEngineeringStatus: "complete" },
      { status: "ready", reverseEngineeringStatus: "complete" },
      { status: "ready", reverseEngineeringStatus: "in_progress" },
      { status: "failed", reverseEngineeringStatus: "not_started" },
      { status: "verifying" },
      { status: "ready", reverseEngineeringStatus: "bogus" as never },
    ]);
    expect(breakdown).toEqual({
      total: 6,
      counts: { not_started: 3, in_progress: 1, complete: 2 },
      notReady: 2,
    });
  });

  it("is all zeros with no firmware", () => {
    expect(firmwareBreakdown([])).toEqual({ total: 0, counts: { not_started: 0, in_progress: 0, complete: 0 }, notReady: 0 });
  });
});

describe("vulnerabilities", () => {
  const cve = (id: string, severity: string, cvssScore: number | null, updatedAt = "2026-01-01T00:00:00Z") =>
    ({ cveId: id, severity, cvssScore, updatedAt }) as { cveId: string; severity: "critical"; cvssScore: number | null; updatedAt: string };

  it("lists every severity with its count, most severe first", () => {
    expect(severityDistribution([cve("a", "high", 7), cve("b", "high", 8), cve("c", "low", null)])).toEqual([
      { severity: "critical", count: 0 },
      { severity: "high", count: 2 },
      { severity: "medium", count: 0 },
      { severity: "low", count: 1 },
    ]);
  });

  it("shows the most severe first, then by CVSS (unscored after scored), then most recent", () => {
    const list = [
      cve("low", "low", 3.1),
      cve("high-7", "high", 7.0),
      cve("crit-none", "critical", null),
      cve("crit-9", "critical", 9.1),
      cve("high-old", "high", 8.0, "2025-01-01T00:00:00Z"),
      cve("high-new", "high", 8.0, "2026-06-01T00:00:00Z"),
      cve("medium", "medium", 5.0),
    ];
    expect(topCves(list, 5).map((c) => c.cveId)).toEqual(["crit-9", "crit-none", "high-new", "high-old", "high-7"]);
    expect(topCves(list).length).toBe(5);
    expect(topCves([], 5)).toEqual([]);
  });
});

describe("notebook summary", () => {
  const entry = (id: string, patch: Partial<NotebookEntry> = {}): NotebookEntry => ({
    entryId: id,
    sectionId: "s",
    title: `Entry ${id}`,
    version: 1,
    contentVersion: 1,
    textLength: 10,
    createdBy: null,
    createdByName: null,
    createdAt: null,
    updatedBy: null,
    updatedByName: null,
    updatedAt: null,
    contentUpdatedBy: null,
    contentUpdatedByName: null,
    contentUpdatedAt: null,
    ...patch,
  });
  const section = (id: string, title: string, entries: NotebookEntry[]): NotebookSection => ({
    sectionId: id,
    title,
    version: 1,
    orderVersion: 1,
    entries: entries.map((e) => ({ ...e, sectionId: id })),
    createdBy: null,
    createdByName: null,
    createdAt: null,
    updatedBy: null,
    updatedByName: null,
    updatedAt: null,
  });

  it("counts sections and entries, empty sections included", () => {
    const summary = notebookSummary({ sections: [section("a", "Hardware", [entry("1"), entry("2")]), section("b", "Empty", [])] });
    expect(summary.sections).toBe(2);
    expect(summary.entries).toBe(2);
    expect(notebookSummary({ sections: [] })).toEqual({ sections: 0, entries: 0, recent: [] });
  });

  it("orders entries by their latest change, with the name recorded for that change", () => {
    const summary = notebookSummary({
      sections: [
        section("hw", "Hardware", [
          entry("uart", {
            createdAt: "2026-01-01T00:00:00Z",
            createdByName: "Ada",
            contentUpdatedAt: "2026-03-01T00:00:00Z",
            contentUpdatedByName: "Grace",
          }),
          // Renamed after its last content save: the rename is its latest change.
          entry("pinout", {
            contentUpdatedAt: "2026-02-01T00:00:00Z",
            contentUpdatedByName: "Ada",
            updatedAt: "2026-04-01T00:00:00Z",
            updatedByName: "Linus",
          }),
        ]),
        section("fw", "Firmware", [
          entry("boot", { createdAt: "2026-02-15T00:00:00Z", createdByName: "Ken" }),
          // Nothing recorded: last, with no time or name.
          entry("bare"),
        ]),
      ],
    });
    expect(summary.recent.map((e) => [e.entryId, e.sectionTitle, e.editedBy, e.editedAt])).toEqual([
      ["pinout", "Hardware", "Linus", "2026-04-01T00:00:00Z"],
      ["uart", "Hardware", "Grace", "2026-03-01T00:00:00Z"],
      ["boot", "Firmware", "Ken", "2026-02-15T00:00:00Z"],
      ["bare", "Firmware", null, null],
    ]);
    expect(summary.recent[0].sectionId).toBe("hw");
  });

  it("leaves the name out when the change has none, and limits the list", () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      entry(String(i), { contentUpdatedAt: `2026-01-0${i + 1}T00:00:00Z`, contentUpdatedByName: i === 7 ? "" : null })
    );
    const summary = notebookSummary({ sections: [section("s", "S", entries)] }, 5);
    expect(summary.entries).toBe(8);
    expect(summary.recent.map((e) => e.entryId)).toEqual(["7", "6", "5", "4", "3"]);
    expect(summary.recent.every((e) => e.editedBy === null)).toBe(true);
  });
});

describe("image preview", () => {
  it("takes the newest few, in the list's order", () => {
    const images = ["a", "b", "c", "d", "e"].map((artifactId) => ({ artifactId }) as ImageArtifact);
    expect(previewImages(images, 4).map((i) => i.artifactId)).toEqual(["a", "b", "c", "d"]);
    expect(previewImages([], 4)).toEqual([]);
  });
});
