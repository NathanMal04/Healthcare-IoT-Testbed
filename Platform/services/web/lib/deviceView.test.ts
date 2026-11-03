import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { DEVICE_SECTIONS, deviceInScope, initialDeviceSection, isDeviceUnavailable } from "./deviceView";

const params = (query: string) => new URLSearchParams(query);

describe("device view", () => {
  it("has the sections in tab order", () => {
    expect(DEVICE_SECTIONS).toEqual(["overview", "firmware", "artifacts", "images", "cves", "notebook"]);
  });

  it("opens the section a link names, a linked CVE's section first, the overview otherwise", () => {
    expect(initialDeviceSection(params("id=d"))).toBe("overview");
    for (const section of DEVICE_SECTIONS) expect(initialDeviceSection(params(`id=d&tab=${section}`))).toBe(section);
    expect(initialDeviceSection(params("id=d&tab=CVEs"))).toBe("overview");
    expect(initialDeviceSection(params("id=d&tab=nope"))).toBe("overview");
    expect(initialDeviceSection(params("id=d&cve=r"))).toBe("cves");
    expect(initialDeviceSection(params("id=d&tab=images&cve=r"))).toBe("cves");
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
});
