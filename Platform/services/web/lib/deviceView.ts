// The Device Details page (/devices/view): its sections, which one a link
// opens, and which devices it may show. Pure, so the rules are tested apart
// from the page.

import { ApiError } from "@/lib/api";

/** The page's sections, in tab order. "notebook" opens the RE Notebook's own page. */
export const DEVICE_SECTIONS = ["overview", "firmware", "artifacts", "images", "cves", "notebook"] as const;
export type DeviceSection = (typeof DEVICE_SECTIONS)[number];

/**
 * The section a link opens: a linked CVE (`cve=`) opens the CVEs section
 * whatever `tab` says; an unknown or missing `tab` opens the overview.
 */
export function initialDeviceSection(params: Pick<URLSearchParams, "get">): DeviceSection {
  if (params.get("cve")) return "cves";
  const tab = params.get("tab");
  return DEVICE_SECTIONS.includes(tab as DeviceSection) ? (tab as DeviceSection) : "overview";
}

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
