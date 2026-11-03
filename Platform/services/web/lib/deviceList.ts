// The Devices page (/devices): search, filters, sorting and the figures shown
// beside each device, worked out from what the existing APIs return. Pure,
// so both views (list and grid) share one tested set of rules. Nothing here
// estimates a value: a count that isn't known stays unknown.

import type { CveSummary } from "@/lib/cves";
import { countDescription, countText, type Count } from "@/lib/deviceOverview";
import type { Device } from "@/lib/devices";
import {
  REVERSE_ENGINEERING_STATUSES,
  toReverseEngineeringStatus,
  type ReverseEngineeringStatus,
} from "@/lib/reverseEngineering";

// --- Search and filters ------------------------------------------------------------

export interface DeviceFilters {
  /** Matched against the name, manufacturer and model number. */
  query: string;
  status: ReverseEngineeringStatus | "";
  /** A manufacturer exactly as `manufacturerOptions` lists it. */
  manufacturer: string;
}

export const EMPTY_DEVICE_FILTERS: DeviceFilters = { query: "", status: "", manufacturer: "" };

export function hasActiveDeviceFilters(filters: DeviceFilters): boolean {
  return filters.query.trim() !== "" || filters.status !== "" || filters.manufacturer !== "";
}

type Searchable = Pick<Device, "name" | "manufacturer" | "modelNumber" | "reverseEngineeringStatus">;

/** Case-insensitive; an empty query matches every device. */
export function matchesDeviceQuery(device: Searchable, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [device.name, device.manufacturer, device.modelNumber].some((value) => value?.toLowerCase().includes(needle));
}

/** Manufacturers compare ignoring case and surrounding space ("Philips" and "philips " are one). */
function manufacturerKey(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

export function filterDeviceList<T extends Searchable>(devices: T[], filters: DeviceFilters): T[] {
  const manufacturer = manufacturerKey(filters.manufacturer);
  return devices.filter(
    (device) =>
      matchesDeviceQuery(device, filters.query) &&
      (!filters.status || toReverseEngineeringStatus(device.reverseEngineeringStatus) === filters.status) &&
      (!manufacturer || manufacturerKey(device.manufacturer) === manufacturer)
  );
}

/** The manufacturers to filter by: one per name (first spelling wins), alphabetical. */
export function manufacturerOptions(devices: Pick<Device, "manufacturer">[]): string[] {
  const byKey = new Map<string, string>();
  for (const { manufacturer } of devices) {
    const key = manufacturerKey(manufacturer);
    if (key && !byKey.has(key)) byKey.set(key, manufacturer!.trim());
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

// --- Per-device figures -------------------------------------------------------------

/**
 * How many CVEs are linked to each device. GET /cves returns every CVE of the
 * scope with its linked devices, so these counts are exact; a device with no
 * entry has none.
 */
export function cveCountsByDevice(cves: Pick<CveSummary, "deviceIds">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cve of cves) {
    for (const deviceId of new Set(cve.deviceIds)) counts.set(deviceId, (counts.get(deviceId) ?? 0) + 1);
  }
  return counts;
}

/**
 * The figures each view shows beside a device. `null` means not known (still
 * loading or couldn't be loaded); the views show that, never a made-up zero.
 */
export interface DeviceStats {
  cves: number | null;
  artifacts: Count | null;
}

export function deviceStats(
  deviceId: string,
  cveCounts: Map<string, number> | null,
  artifactCounts: ReadonlyMap<string, Count>
): DeviceStats {
  return {
    cves: cveCounts ? cveCounts.get(deviceId) ?? 0 : null,
    artifacts: artifactCounts.get(deviceId) ?? null,
  };
}

/** A figure as the views show it: the value, still loading, or not available. */
export type Figure =
  | { state: "ready"; text: string; description: string }
  | { state: "loading" }
  | { state: "unavailable" };

export function cveFigure(count: number | null, failed: boolean): Figure {
  if (count !== null) return { state: "ready", text: String(count), description: String(count) };
  return failed ? { state: "unavailable" } : { state: "loading" };
}

export function artifactFigure(count: Count | null, failed: boolean): Figure {
  if (count) {
    return { state: "ready", text: countText(count), description: countDescription(count) };
  }
  return failed ? { state: "unavailable" } : { state: "loading" };
}

// --- Sorting ------------------------------------------------------------------------

export const DEVICE_SORT_KEYS = ["name", "manufacturer", "status", "cves", "artifacts", "updated"] as const;
export type DeviceSortKey = (typeof DEVICE_SORT_KEYS)[number];
export interface DeviceSort {
  key: DeviceSortKey;
  direction: "asc" | "desc";
}

export const DEFAULT_DEVICE_SORT: DeviceSort = { key: "name", direction: "asc" };

/** Labels for the sort menu (the grid has no column headers), every key in both directions. */
export const DEVICE_SORT_OPTIONS: { sort: DeviceSort; label: string }[] = [
  { sort: { key: "name", direction: "asc" }, label: "Name (A–Z)" },
  { sort: { key: "name", direction: "desc" }, label: "Name (Z–A)" },
  { sort: { key: "manufacturer", direction: "asc" }, label: "Manufacturer (A–Z)" },
  { sort: { key: "manufacturer", direction: "desc" }, label: "Manufacturer (Z–A)" },
  { sort: { key: "status", direction: "desc" }, label: "Status: complete first" },
  { sort: { key: "status", direction: "asc" }, label: "Status: not started first" },
  { sort: { key: "cves", direction: "desc" }, label: "Most CVEs" },
  { sort: { key: "cves", direction: "asc" }, label: "Fewest CVEs" },
  { sort: { key: "artifacts", direction: "desc" }, label: "Most artifacts" },
  { sort: { key: "artifacts", direction: "asc" }, label: "Fewest artifacts" },
  { sort: { key: "updated", direction: "desc" }, label: "Recently updated" },
  { sort: { key: "updated", direction: "asc" }, label: "Least recently updated" },
];

export function sortValue(sort: DeviceSort): string {
  return `${sort.key}:${sort.direction}`;
}

export function parseSortValue(value: string): DeviceSort | null {
  const [key, direction] = value.split(":");
  if (!DEVICE_SORT_KEYS.includes(key as DeviceSortKey) || (direction !== "asc" && direction !== "desc")) return null;
  return { key: key as DeviceSortKey, direction };
}

const STATUS_RANK: Record<ReverseEngineeringStatus, number> = Object.fromEntries(
  REVERSE_ENGINEERING_STATUSES.map((status, i) => [status, i])
) as Record<ReverseEngineeringStatus, number>;

const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

type SortValue = string | number | null;

function valueFor(device: Device, key: DeviceSortKey, stats: DeviceStats): SortValue {
  switch (key) {
    case "name":
      return device.name;
    case "manufacturer":
      return device.manufacturer?.trim() || null;
    case "status":
      return STATUS_RANK[toReverseEngineeringStatus(device.reverseEngineeringStatus)];
    case "cves":
      return stats.cves;
    case "artifacts":
      return stats.artifacts?.value ?? null;
    case "updated": {
      const time = device.updatedAt ? Date.parse(device.updatedAt) : NaN;
      return Number.isNaN(time) ? null : time;
    }
  }
}

/**
 * The devices in the chosen order. A device without the value (no
 * manufacturer, a count not loaded yet, no update time) goes last in either
 * direction; ties are broken by name, so the order never jumps around.
 */
export function sortDeviceList(
  devices: Device[],
  sort: DeviceSort,
  statsFor: (device: Device) => DeviceStats
): Device[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  const keyed = devices.map((device) => ({ device, value: valueFor(device, sort.key, statsFor(device)) }));
  keyed.sort((a, b) => {
    if (a.value === null || b.value === null) {
      if (a.value !== b.value) return a.value === null ? 1 : -1;
    } else {
      const order =
        typeof a.value === "number" && typeof b.value === "number"
          ? a.value - b.value
          : compareText(String(a.value), String(b.value));
      if (order !== 0) return sign * order;
    }
    return compareText(a.device.name, b.device.name) || a.device.deviceId.localeCompare(b.device.deviceId);
  });
  return keyed.map(({ device }) => device);
}

// --- Remembered view ----------------------------------------------------------------

// Like the shell's sidebar preference: remembered per user on this browser,
// only the layout choice is stored, and unreadable or blocked storage means
// the default (the list).

export const DEVICE_VIEWS = ["list", "grid"] as const;
export type DeviceView = (typeof DEVICE_VIEWS)[number];
export const DEFAULT_DEVICE_VIEW: DeviceView = "list";

const VIEW_PREFIX = "vzoniq.devices.v1.";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readDeviceView(userId: string | undefined): DeviceView {
  if (!userId) return DEFAULT_DEVICE_VIEW;
  try {
    const raw = storage()?.getItem(VIEW_PREFIX + userId);
    const value = raw ? (JSON.parse(raw) as { view?: unknown } | null) : null;
    return DEVICE_VIEWS.includes(value?.view as DeviceView) ? (value!.view as DeviceView) : DEFAULT_DEVICE_VIEW;
  } catch {
    return DEFAULT_DEVICE_VIEW;
  }
}

export function writeDeviceView(userId: string | undefined, view: DeviceView): void {
  if (!userId) return;
  try {
    storage()?.setItem(VIEW_PREFIX + userId, JSON.stringify({ view }));
  } catch {
    // Not remembered; the page still works for this visit.
  }
}
