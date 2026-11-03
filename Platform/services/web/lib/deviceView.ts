// The Device Details page (/devices/view): its sections, which one a URL
// shows, their links and breadcrumbs, and which devices it may show. Pure, so
// the rules are tested apart from the page.

import { ApiError } from "@/lib/api";
import type { PanelLimits } from "@/lib/panelLayout";
import { deviceHref, notebookHref } from "@/lib/routes";

/** The page's sections, in navigation order. "notebook" opens the RE Notebook's own page. */
export const DEVICE_SECTIONS = ["overview", "firmware", "artifacts", "images", "cves", "notebook"] as const;
export type DeviceSection = (typeof DEVICE_SECTIONS)[number];
/** The sections shown on the page itself (the RE Notebook is a full-screen page of its own). */
export type DevicePageSection = Exclude<DeviceSection, "notebook">;

/** Display names. The URL keeps "cves" for Vulnerabilities, so older links still work. */
export const DEVICE_SECTION_LABELS: Record<DeviceSection, string> = {
  overview: "Overview",
  firmware: "Firmware",
  artifacts: "Artifacts",
  images: "Images",
  cves: "Vulnerabilities",
  notebook: "RE Notebook",
};

/**
 * The section a URL shows: a linked CVE (`cve=`) is in Vulnerabilities
 * whatever `tab` says; an unknown or missing `tab` is the overview. (A
 * `tab=notebook` link is redirected to the RE Notebook before this is asked.)
 */
export function deviceSectionFromParams(params: Pick<URLSearchParams, "get">): DeviceSection {
  if (params.get("cve")) return "cves";
  const tab = params.get("tab");
  return DEVICE_SECTIONS.includes(tab as DeviceSection) ? (tab as DeviceSection) : "overview";
}

/** A section's link; the overview is the device's plain link. */
export function deviceSectionHref(deviceId: string, section: DeviceSection): string {
  if (section === "notebook") return notebookHref(deviceId);
  return deviceHref(deviceId, section === "overview" ? undefined : section);
}

export interface DeviceCrumb {
  label: string;
  href?: string;
}

/**
 * The top bar's trail: Devices / {device} / {section}, and for a linked CVE
 * Devices / {device} / Vulnerabilities / {CVE ID} ("Vulnerability" until the
 * CVE has loaded). The last step is the current page, so it has no link.
 */
export function deviceCrumbs(
  device: { deviceId: string; name: string },
  section: DeviceSection,
  linkedCve?: { label?: string } | null
): DeviceCrumb[] {
  const trail: DeviceCrumb[] = [
    { label: "Devices", href: "/devices" },
    { label: device.name, href: deviceHref(device.deviceId) },
  ];
  if (section === "cves" && linkedCve) {
    trail.push({ label: DEVICE_SECTION_LABELS.cves, href: deviceHref(device.deviceId, "cves") });
    trail.push({ label: linkedCve.label || "Vulnerability" });
  } else {
    trail.push({ label: DEVICE_SECTION_LABELS[section] });
  }
  return trail;
}

/** The sections shown on the page, in navigation order. */
export const DEVICE_PAGE_SECTIONS: DevicePageSection[] = ["overview", "firmware", "artifacts", "images", "cves"];

/**
 * Whether a link stays on this device's page (another section, a linked
 * CVE): the page keeps any work in progress running across those.
 */
export function isDevicePageUrl(url: URL, deviceId: string): boolean {
  return url.pathname.replace(/(\.html|\/)$/, "") === "/devices/view" && url.searchParams.get("id") === deviceId;
}

/**
 * Which sections stay mounted besides the open one, so switching section
 * (by link, Back or Forward) never unmounts work in progress:
 * - `busy`: holding the workspace (an upload or save is running in it);
 * - `kept`: was busy and hasn't been looked at since, so the outcome (a
 *   finished upload, failures to retry) is still there to see.
 * A kept section is let go once the user opens it with nothing running, or
 * dismisses its notice.
 */
export interface SectionActivity {
  open: DeviceSection;
  busy: DevicePageSection[];
  kept: DevicePageSection[];
}

export type SectionActivityEvent =
  | { type: "opened"; section: DeviceSection }
  | { type: "busy"; section: DevicePageSection; busy: boolean }
  | { type: "dismissed"; section: DevicePageSection };

const without = (list: DevicePageSection[], section: DeviceSection) => list.filter((s) => s !== section);
const withSection = (list: DevicePageSection[], section: DevicePageSection) => (list.includes(section) ? list : [...list, section]);

export function sectionActivity(state: SectionActivity, event: SectionActivityEvent): SectionActivity {
  switch (event.type) {
    case "opened":
      if (event.section === state.open) return state;
      return {
        open: event.section,
        busy: state.busy,
        // Opening a kept section shows its outcome; from then on it's an ordinary section.
        kept: state.busy.includes(event.section as DevicePageSection) ? state.kept : without(state.kept, event.section),
      };
    case "busy":
      if (event.busy) {
        if (state.busy.includes(event.section)) return state;
        return { ...state, busy: [...state.busy, event.section], kept: withSection(state.kept, event.section) };
      }
      if (!state.busy.includes(event.section)) return state;
      return {
        ...state,
        busy: without(state.busy, event.section),
        // Finished in view: nothing left to come back for.
        kept: event.section === state.open ? without(state.kept, event.section) : state.kept,
      };
    case "dismissed":
      if (state.busy.includes(event.section) || !state.kept.includes(event.section)) return state;
      return { ...state, kept: without(state.kept, event.section) };
  }
}

/** The sections to render: the open one, and any busy or kept one (hidden). */
export function mountedSections(state: SectionActivity): DevicePageSection[] {
  return DEVICE_PAGE_SECTIONS.filter((s) => s === state.open || state.busy.includes(s) || state.kept.includes(s));
}

/**
 * The device's section navigation beside the content (1280px and wider):
 * expanded or an icon rail, the choice remembered per user (lib/panelLayout,
 * view "device.nav"). Its width is fixed, so only the collapsed flag matters.
 */
export const DEVICE_NAV_VIEW = "device.nav";
export const DEVICE_NAV_LIMITS: PanelLimits = { min: 208, max: 208, initial: 208 };

/**
 * The device is shown only in its own scope: one of another workspace, or a
 * personal device while a workspace is selected (and the reverse), is null.
 */
export function deviceInScope<T extends { workspaceId?: string }>(device: T, workspaceId: string | undefined): T | null {
  return device.workspaceId === workspaceId ? device : null;
}

/** A failed device load that means "not available to you here" rather than an error. */
export function isDeviceUnavailable(err: unknown): boolean {
  return err instanceof ApiError && [400, 403, 404].includes(err.status);
}
