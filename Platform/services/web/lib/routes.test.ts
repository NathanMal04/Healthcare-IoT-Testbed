import { describe, expect, it } from "vitest";
import { cveHref, deviceHref } from "./routes";

describe("deviceHref", () => {
  it("links to the device, optionally on a tab", () => {
    expect(deviceHref("d1")).toBe("/devices/view?id=d1");
    expect(deviceHref("d1", "firmware")).toBe("/devices/view?id=d1&tab=firmware");
  });

  it("opens a linked CVE on the device's CVEs tab", () => {
    expect(deviceHref("d1", undefined, { cve: "c1" })).toBe("/devices/view?id=d1&tab=cves&cve=c1");
    expect(deviceHref("d1", "overview", { cve: "c1" })).toBe("/devices/view?id=d1&tab=cves&cve=c1");
  });

  it("encodes ids", () => {
    expect(deviceHref("a b", undefined, { cve: "x&y" })).toBe("/devices/view?id=a+b&tab=cves&cve=x%26y");
  });
});

describe("cveHref", () => {
  it("still links to the Vulnerabilities CVE page", () => {
    expect(cveHref("c1")).toBe("/vulnerabilities/view?id=c1");
    expect(cveHref("c1", "devices", { edit: true })).toBe("/vulnerabilities/view?id=c1&tab=devices&edit=1");
  });
});
