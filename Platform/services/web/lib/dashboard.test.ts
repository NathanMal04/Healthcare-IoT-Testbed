import { describe, expect, it, vi } from "vitest";

// lib/cves imports lib/api, which pulls in Amplify; only constants are needed here.
vi.mock("@/lib/api", () => ({ ApiError: class extends Error {}, apiRequest: vi.fn() }));

import { countLabel, cvesForDevice, filterDevices, recentCves, reProgress, severityCounts } from "@/lib/dashboard";

describe("countLabel", () => {
  it("is exact when the list is complete", () => {
    expect(countLabel(0, false)).toBe("0");
    expect(countLabel(37, false)).toBe("37");
  });

  it("is a lower bound when more pages exist", () => {
    expect(countLabel(100, true)).toBe("100+");
    expect(countLabel(4, true)).toBe("4+");
  });
});

describe("reProgress", () => {
  it("counts each status and treats a missing status as not started", () => {
    const result = reProgress([
      { reverseEngineeringStatus: "complete" },
      { reverseEngineeringStatus: "in_progress" },
      { reverseEngineeringStatus: "in_progress" },
      { reverseEngineeringStatus: undefined },
      { reverseEngineeringStatus: "bogus" },
    ]);
    expect(result.total).toBe(5);
    expect(result.counts).toEqual({ not_started: 2, in_progress: 2, complete: 1 });
  });

  it("returns percentages that always sum to 100", () => {
    for (const items of [
      [{ reverseEngineeringStatus: "complete" }, { reverseEngineeringStatus: "in_progress" }, { reverseEngineeringStatus: "not_started" }],
      Array.from({ length: 7 }, (_, i) => ({ reverseEngineeringStatus: ["complete", "in_progress", "not_started"][i % 3] })),
      [{ reverseEngineeringStatus: "complete" }],
    ]) {
      const { percents } = reProgress(items);
      expect(percents.not_started + percents.in_progress + percents.complete).toBe(100);
    }
    expect(reProgress([{ reverseEngineeringStatus: "complete" }, { reverseEngineeringStatus: "not_started" }]).percents).toEqual({
      not_started: 50,
      in_progress: 0,
      complete: 50,
    });
  });

  it("is all zero with no items", () => {
    expect(reProgress([])).toEqual({
      total: 0,
      counts: { not_started: 0, in_progress: 0, complete: 0 },
      percents: { not_started: 0, in_progress: 0, complete: 0 },
    });
  });
});

describe("severityCounts", () => {
  it("counts every severity, including zeroes", () => {
    expect(severityCounts([{ severity: "high" }, { severity: "high" }, { severity: "critical" }])).toEqual({
      critical: 1,
      high: 2,
      medium: 0,
      low: 0,
    });
  });
});

describe("recentCves", () => {
  it("orders by updatedAt, newest first, and limits the result", () => {
    const cves = [
      { id: "a", updatedAt: "2026-10-01T00:00:00Z" },
      { id: "b", updatedAt: "2026-10-05T00:00:00Z" },
      { id: "c", updatedAt: "2026-10-03T00:00:00Z" },
    ];
    expect(recentCves(cves, 2).map((c) => c.id)).toEqual(["b", "c"]);
    expect(cves.map((c) => c.id)).toEqual(["a", "b", "c"]); // input untouched
  });
});

describe("cvesForDevice", () => {
  it("keeps CVEs linked to the device, including none for deviceIds []", () => {
    const cves = [
      { id: "a", deviceIds: ["d1", "d2"] },
      { id: "b", deviceIds: [] },
      { id: "c", deviceIds: ["d2"] },
    ];
    expect(cvesForDevice(cves, "d2").map((c) => c.id)).toEqual(["a", "c"]);
    expect(cvesForDevice(cves, "d1").map((c) => c.id)).toEqual(["a"]);
    expect(cvesForDevice(cves, "d9")).toEqual([]);
  });
});

describe("filterDevices", () => {
  const devices = [
    { name: "Infusion Pump X100", reverseEngineeringStatus: "in_progress" },
    { name: "ICU Heart Monitor", reverseEngineeringStatus: "complete" },
    { name: "Test Device", reverseEngineeringStatus: undefined },
  ];

  it("searches names case-insensitively", () => {
    expect(filterDevices(devices, "  pump ", "").map((d) => d.name)).toEqual(["Infusion Pump X100"]);
    expect(filterDevices(devices, "", "")).toHaveLength(3);
  });

  it("filters by reverse-engineering status, treating missing as not started", () => {
    expect(filterDevices(devices, "", "not_started").map((d) => d.name)).toEqual(["Test Device"]);
    expect(filterDevices(devices, "monitor", "complete").map((d) => d.name)).toEqual(["ICU Heart Monitor"]);
    expect(filterDevices(devices, "monitor", "in_progress")).toEqual([]);
  });
});
