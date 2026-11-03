import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  DEVICE_SECTIONS,
  DEVICE_SECTION_LABELS,
  deviceCrumbs,
  deviceInScope,
  deviceSectionFromParams,
  deviceSectionHref,
  isDevicePageUrl,
  isDeviceUnavailable,
  mountedSections,
  sectionActivity,
  type SectionActivity,
  type SectionActivityEvent,
} from "./deviceView";

const params = (query: string) => new URLSearchParams(query);

describe("device view", () => {
  it("has the sections in navigation order, Vulnerabilities kept as cves", () => {
    expect(DEVICE_SECTIONS.map((s) => `${s}:${DEVICE_SECTION_LABELS[s]}`)).toEqual([
      "overview:Overview",
      "firmware:Firmware",
      "artifacts:Artifacts",
      "images:Images",
      "cves:Vulnerabilities",
      "notebook:RE Notebook",
    ]);
  });

  it("reads the section from the URL, a linked CVE's section first, the overview otherwise", () => {
    expect(deviceSectionFromParams(params("id=d"))).toBe("overview");
    for (const section of DEVICE_SECTIONS) expect(deviceSectionFromParams(params(`id=d&tab=${section}`))).toBe(section);
    expect(deviceSectionFromParams(params("id=d&tab=CVEs"))).toBe("overview");
    expect(deviceSectionFromParams(params("id=d&tab=vulnerabilities"))).toBe("overview");
    expect(deviceSectionFromParams(params("id=d&tab=nope"))).toBe("overview");
    expect(deviceSectionFromParams(params("id=d&cve=r"))).toBe("cves");
    expect(deviceSectionFromParams(params("id=d&tab=images&cve=r"))).toBe("cves");
  });

  it("links each section, the overview without a tab and the notebook to its own page", () => {
    expect(DEVICE_SECTIONS.map((s) => deviceSectionHref("d-1", s))).toEqual([
      "/devices/view?id=d-1",
      "/devices/view?id=d-1&tab=firmware",
      "/devices/view?id=d-1&tab=artifacts",
      "/devices/view?id=d-1&tab=images",
      "/devices/view?id=d-1&tab=cves",
      "/devices/notebook?id=d-1",
    ]);
  });

  it("builds the breadcrumb trail down to the section or linked CVE", () => {
    const device = { deviceId: "d-1", name: "Pump" };
    const base = [
      { label: "Devices", href: "/devices" },
      { label: "Pump", href: "/devices/view?id=d-1" },
    ];
    expect(deviceCrumbs(device, "overview")).toEqual([...base, { label: "Overview" }]);
    expect(deviceCrumbs(device, "cves")).toEqual([...base, { label: "Vulnerabilities" }]);
    expect(deviceCrumbs(device, "cves", {})).toEqual([
      ...base,
      { label: "Vulnerabilities", href: "/devices/view?id=d-1&tab=cves" },
      { label: "Vulnerability" },
    ]);
    expect(deviceCrumbs(device, "cves", { label: "CVE-2024-0001" }).at(-1)).toEqual({ label: "CVE-2024-0001" });
  });

  it("shows a device only in its own scope", () => {
    expect(deviceInScope({ workspaceId: "ws-1" }, "ws-1")).toEqual({ workspaceId: "ws-1" });
    expect(deviceInScope({}, undefined)).toEqual({});
    expect(deviceInScope({ workspaceId: "ws-1" }, "ws-2")).toBeNull();
    expect(deviceInScope({ workspaceId: "ws-1" }, undefined)).toBeNull();
    expect(deviceInScope({}, "ws-1")).toBeNull();
  });

  it("treats refusals as unavailable and anything else as an error", () => {
    for (const status of [400, 403, 404]) expect(isDeviceUnavailable(new ApiError("x", status))).toBe(true);
    for (const status of [401, 409, 500]) expect(isDeviceUnavailable(new ApiError("x", status))).toBe(false);
    expect(isDeviceUnavailable(new Error("network"))).toBe(false);
  });

  it("knows which links stay on this device's page", () => {
    const url = (path: string) => new URL(path, "https://vzoniq.com");
    expect(isDevicePageUrl(url("/devices/view?id=d-1&tab=firmware"), "d-1")).toBe(true);
    expect(isDevicePageUrl(url("/devices/view/?id=d-1"), "d-1")).toBe(true);
    expect(isDevicePageUrl(url("/devices/view.html?id=d-1&tab=cves&cve=r"), "d-1")).toBe(true);
    expect(isDevicePageUrl(url("/devices/view?id=d-2"), "d-1")).toBe(false);
    expect(isDevicePageUrl(url("/devices/notebook?id=d-1"), "d-1")).toBe(false);
    expect(isDevicePageUrl(url("/devices"), "d-1")).toBe(false);
  });
});

describe("sections kept mounted while work runs", () => {
  const start: SectionActivity = { open: "artifacts", busy: [], kept: [] };
  const run = (...events: SectionActivityEvent[]) => events.reduce(sectionActivity, start);

  it("mounts only the open section when nothing is running", () => {
    expect(mountedSections(start)).toEqual(["artifacts"]);
    expect(mountedSections(run({ type: "opened", section: "firmware" }))).toEqual(["firmware"]);
  });

  it("keeps a busy section mounted while other sections are opened, back and forth", () => {
    const state = run(
      { type: "busy", section: "artifacts", busy: true },
      { type: "opened", section: "firmware" },
      { type: "opened", section: "overview" },
      { type: "opened", section: "firmware" }
    );
    expect(mountedSections(state)).toEqual(["firmware", "artifacts"]);
    // Back to it, still running: still kept.
    const back = sectionActivity(state, { type: "opened", section: "artifacts" });
    expect(back.kept).toEqual(["artifacts"]);
    expect(mountedSections(sectionActivity(back, { type: "opened", section: "images" }))).toEqual(["artifacts", "images"]);
  });

  it("keeps a section that finished out of view until it is opened or dismissed", () => {
    const finished = run(
      { type: "busy", section: "artifacts", busy: true },
      { type: "opened", section: "firmware" },
      { type: "busy", section: "artifacts", busy: false }
    );
    expect(finished.busy).toEqual([]);
    expect(mountedSections(finished)).toEqual(["firmware", "artifacts"]);
    // Opened: the outcome is seen, so leaving it again unmounts it.
    const seen = sectionActivity(finished, { type: "opened", section: "artifacts" });
    expect(mountedSections(sectionActivity(seen, { type: "opened", section: "overview" }))).toEqual(["overview"]);
    // Or dismissed from the other section.
    expect(mountedSections(sectionActivity(finished, { type: "dismissed", section: "artifacts" }))).toEqual(["firmware"]);
  });

  it("lets go of a section whose work finished while it was open", () => {
    const state = run({ type: "busy", section: "artifacts", busy: true }, { type: "busy", section: "artifacts", busy: false });
    expect(state.kept).toEqual([]);
    expect(mountedSections(sectionActivity(state, { type: "opened", section: "images" }))).toEqual(["images"]);
  });

  it("can't dismiss work that is still running, and ignores repeated reports", () => {
    const busy = run({ type: "busy", section: "firmware", busy: true }, { type: "opened", section: "overview" });
    expect(sectionActivity(busy, { type: "dismissed", section: "firmware" })).toBe(busy);
    expect(sectionActivity(busy, { type: "busy", section: "firmware", busy: true })).toBe(busy);
    expect(sectionActivity(start, { type: "busy", section: "firmware", busy: false })).toBe(start);
    expect(sectionActivity(busy, { type: "opened", section: "overview" })).toBe(busy);
  });

  it("tracks several busy sections at once", () => {
    const state = run(
      { type: "busy", section: "artifacts", busy: true },
      { type: "opened", section: "images" },
      { type: "busy", section: "images", busy: true },
      { type: "opened", section: "overview" }
    );
    expect(mountedSections(state)).toEqual(["overview", "artifacts", "images"]);
  });
});
