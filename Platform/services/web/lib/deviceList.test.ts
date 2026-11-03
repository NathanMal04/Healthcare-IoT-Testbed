import { afterEach, describe, expect, it, vi } from "vitest";
import type { Device } from "@/lib/devices";
import {
  DEFAULT_DEVICE_VIEW,
  DEVICE_SORT_KEYS,
  DEVICE_SORT_OPTIONS,
  EMPTY_DEVICE_FILTERS,
  artifactFigure,
  cveCountsByDevice,
  cveFigure,
  deviceStats,
  filterDeviceList,
  hasActiveDeviceFilters,
  manufacturerOptions,
  matchesDeviceQuery,
  parseSortValue,
  readDeviceView,
  sortDeviceList,
  sortValue,
  writeDeviceView,
  type DeviceStats,
} from "@/lib/deviceList";

function device(id: string, overrides: Partial<Device> = {}): Device {
  return { deviceId: id, name: `Device ${id}`, role: "owner", reverseEngineeringStatus: "not_started", ...overrides };
}

const pump = device("a", { name: "Infusion Pump", manufacturer: "Baxter", modelNumber: "SIGMA-1", reverseEngineeringStatus: "complete" });
const monitor = device("b", { name: "ICU Monitor", manufacturer: "Philips", modelNumber: "MX800", reverseEngineeringStatus: "in_progress" });
const watch = device("c", { name: "HR Watch", manufacturer: "philips ", reverseEngineeringStatus: "not_started" });
const bare = device("d", { name: "Unknown dongle" });
const ALL = [pump, monitor, watch, bare];

describe("search and filters", () => {
  it("searches the name, manufacturer and model number, ignoring case and surrounding space", () => {
    expect(matchesDeviceQuery(pump, "  infusion ")).toBe(true);
    expect(matchesDeviceQuery(pump, "baxter")).toBe(true);
    expect(matchesDeviceQuery(monitor, "mx8")).toBe(true);
    expect(matchesDeviceQuery(bare, "philips")).toBe(false);
    expect(matchesDeviceQuery(bare, "")).toBe(true);
  });

  it("combines the query, status and manufacturer", () => {
    expect(filterDeviceList(ALL, { ...EMPTY_DEVICE_FILTERS, manufacturer: "Philips" }).map((d) => d.deviceId)).toEqual(["b", "c"]);
    expect(filterDeviceList(ALL, { query: "", status: "in_progress", manufacturer: "Philips" }).map((d) => d.deviceId)).toEqual(["b"]);
    expect(filterDeviceList(ALL, { query: "watch", status: "complete", manufacturer: "" })).toEqual([]);
    expect(filterDeviceList(ALL, EMPTY_DEVICE_FILTERS)).toHaveLength(4);
  });

  it("knows when any filter is active", () => {
    expect(hasActiveDeviceFilters(EMPTY_DEVICE_FILTERS)).toBe(false);
    expect(hasActiveDeviceFilters({ ...EMPTY_DEVICE_FILTERS, query: "   " })).toBe(false);
    expect(hasActiveDeviceFilters({ ...EMPTY_DEVICE_FILTERS, manufacturer: "Baxter" })).toBe(true);
  });

  it("lists each manufacturer once, alphabetically, skipping devices without one", () => {
    expect(manufacturerOptions(ALL)).toEqual(["Baxter", "Philips"]);
    expect(manufacturerOptions([bare])).toEqual([]);
  });
});

describe("per-device figures", () => {
  it("counts the CVEs linked to each device", () => {
    const counts = cveCountsByDevice([{ deviceIds: ["a", "b"] }, { deviceIds: ["a"] }, { deviceIds: [] }, { deviceIds: ["a", "a"] }]);
    expect(counts.get("a")).toBe(3);
    expect(counts.get("b")).toBe(1);
    expect(counts.has("c")).toBe(false);
  });

  it("reports zero CVEs once the list is loaded, and unknown before", () => {
    const artifacts = new Map([["a", { value: 4, exact: true }]]);
    expect(deviceStats("c", new Map(), artifacts)).toEqual({ cves: 0, artifacts: null });
    expect(deviceStats("a", null, artifacts)).toEqual({ cves: null, artifacts: { value: 4, exact: true } });
  });

  it("shows a count, a lower bound, a placeholder or a dash, never an invented zero", () => {
    expect(cveFigure(2, false)).toEqual({ state: "ready", text: "2", description: "2" });
    expect(cveFigure(null, false)).toEqual({ state: "loading" });
    expect(cveFigure(null, true)).toEqual({ state: "unavailable" });
    expect(artifactFigure({ value: 100, exact: false }, false)).toEqual({ state: "ready", text: "100+", description: "at least 100" });
    expect(artifactFigure(null, true)).toEqual({ state: "unavailable" });
  });
});

describe("sorting", () => {
  const stats: Record<string, DeviceStats> = {
    a: { cves: 1, artifacts: { value: 10, exact: true } },
    b: { cves: 5, artifacts: null },
    c: { cves: 0, artifacts: { value: 2, exact: true } },
    d: { cves: null, artifacts: { value: 2, exact: true } },
  };
  const statsFor = (d: Device) => stats[d.deviceId];
  const ids = (devices: Device[]) => devices.map((d) => d.deviceId);

  it("sorts by name in either direction", () => {
    expect(ids(sortDeviceList(ALL, { key: "name", direction: "asc" }, statsFor))).toEqual(["c", "b", "a", "d"]);
    expect(ids(sortDeviceList(ALL, { key: "name", direction: "desc" }, statsFor))).toEqual(["d", "a", "b", "c"]);
  });

  it("puts devices without the value last in both directions", () => {
    expect(ids(sortDeviceList(ALL, { key: "cves", direction: "desc" }, statsFor))).toEqual(["b", "a", "c", "d"]);
    expect(ids(sortDeviceList(ALL, { key: "cves", direction: "asc" }, statsFor))).toEqual(["c", "a", "b", "d"]);
    expect(ids(sortDeviceList(ALL, { key: "manufacturer", direction: "desc" }, statsFor)).at(-1)).toBe("d");
  });

  it("breaks ties by name", () => {
    // c and d both have 2 artifacts: HR Watch before Unknown dongle.
    expect(ids(sortDeviceList(ALL, { key: "artifacts", direction: "asc" }, statsFor))).toEqual(["c", "d", "a", "b"]);
  });

  it("orders statuses by progress", () => {
    expect(ids(sortDeviceList(ALL, { key: "status", direction: "desc" }, statsFor))).toEqual(["a", "b", "c", "d"]);
  });

  it("sorts by last update, newest first, devices without a time last", () => {
    const dated = [
      device("x", { updatedAt: "2026-01-01T00:00:00Z" }),
      device("y"),
      device("z", { updatedAt: "2026-06-01T00:00:00Z" }),
      device("w", { updatedAt: "not a date" }),
    ];
    const none = () => ({ cves: null, artifacts: null });
    expect(ids(sortDeviceList(dated, { key: "updated", direction: "desc" }, none))).toEqual(["z", "x", "w", "y"]);
  });

  it("offers every key in both directions in the sort menu, and round-trips its values", () => {
    expect(DEVICE_SORT_OPTIONS).toHaveLength(DEVICE_SORT_KEYS.length * 2);
    for (const { sort } of DEVICE_SORT_OPTIONS) expect(parseSortValue(sortValue(sort))).toEqual(sort);
    expect(parseSortValue("bogus:asc")).toBeNull();
    expect(parseSortValue("name:sideways")).toBeNull();
  });
});

describe("remembered view", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    return store;
  }

  it("defaults to the list", () => {
    expect(DEFAULT_DEVICE_VIEW).toBe("list");
    expect(readDeviceView("user-1")).toBe("list"); // no window (Node)
    stubStorage();
    expect(readDeviceView("user-1")).toBe("list");
    expect(readDeviceView(undefined)).toBe("list");
  });

  it("remembers the view per user", () => {
    const store = stubStorage();
    writeDeviceView("user-1", "grid");
    expect(readDeviceView("user-1")).toBe("grid");
    expect(readDeviceView("user-2")).toBe("list");
    expect([...store.values()]).toEqual([JSON.stringify({ view: "grid" })]);
  });

  it("ignores unreadable or unknown values, and blocked storage", () => {
    const store = stubStorage();
    store.set("vzoniq.devices.v1.user-1", "{not json");
    expect(readDeviceView("user-1")).toBe("list");
    store.set("vzoniq.devices.v1.user-1", JSON.stringify({ view: "table" }));
    expect(readDeviceView("user-1")).toBe("list");

    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(() => writeDeviceView("user-1", "grid")).not.toThrow();
    expect(readDeviceView("user-1")).toBe("list");
  });
});
