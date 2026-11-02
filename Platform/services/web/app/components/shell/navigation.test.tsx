import { describe, expect, it } from "vitest";
import { NAV_SECTIONS, SYSTEM_ITEMS, contentWidth, routeCrumbs } from "./navigation";

describe("navigation", () => {
  it("groups the pages, with every URL unchanged", () => {
    expect(NAV_SECTIONS.map((s) => [s.label, s.items.map((i) => `${i.label} ${i.href}`)])).toEqual([
      ["Research", ["Dashboard /dashboard", "Devices /devices", "Firmware /firmware", "Artifacts /artifacts", "Vulnerabilities /vulnerabilities"]],
      ["Analysis", ["Scripts /scripts", "Environments /environments", "Runs /runs", "Analysis Notebooks /notebooks"]],
    ]);
    expect(SYSTEM_ITEMS.map((i) => `${i.label} ${i.href}`)).toEqual(["Workspaces /workspaces", "Usage /usage"]);
  });

  it("derives breadcrumbs from the route, with detail pages under their list", () => {
    expect(routeCrumbs("/devices")).toEqual([{ label: "Devices", href: "/devices" }]);
    expect(routeCrumbs("/devices.html")).toEqual([{ label: "Devices", href: "/devices" }]);
    expect(routeCrumbs("/devices/view")).toEqual([{ label: "Devices", href: "/devices" }, { label: "Device" }]);
    expect(routeCrumbs("/vulnerabilities/view/")).toEqual([
      { label: "Vulnerabilities", href: "/vulnerabilities" },
      { label: "Vulnerability" },
    ]);
    expect(routeCrumbs("/notebooks")).toEqual([{ label: "Analysis Notebooks", href: "/notebooks" }]);
    expect(routeCrumbs("/usage")).toEqual([{ label: "Usage", href: "/usage" }]);
    expect(routeCrumbs("/somewhere-else")).toEqual([]);
  });

  it("gives tables and workspaces the fluid width, detail and settings pages the default", () => {
    for (const path of ["/dashboard", "/devices", "/devices/view", "/firmware", "/artifacts", "/vulnerabilities", "/scripts", "/environments", "/runs", "/notebooks"]) {
      expect([path, contentWidth(path)]).toEqual([path, "fluid"]);
    }
    for (const path of ["/vulnerabilities/view", "/workspaces", "/usage"]) {
      expect([path, contentWidth(path)]).toEqual([path, "default"]);
    }
  });
});
