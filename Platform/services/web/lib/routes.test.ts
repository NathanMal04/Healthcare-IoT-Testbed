import { describe, expect, it } from "vitest";
import { cveHref, deviceHref, legacyNotebookHref, notebookHref } from "./routes";

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

describe("notebookHref", () => {
  it("links to the device's RE Notebook workspace, optionally on a section or entry", () => {
    expect(notebookHref("d1")).toBe("/devices/notebook?id=d1");
    expect(notebookHref("d1", { section: "s1" })).toBe("/devices/notebook?id=d1&section=s1");
    expect(notebookHref("d1", { section: "s1", entry: "e1" })).toBe("/devices/notebook?id=d1&section=s1&entry=e1");
    expect(notebookHref("a b", { entry: "x&y" })).toBe("/devices/notebook?id=a+b&entry=x%26y");
  });
});

describe("legacyNotebookHref", () => {
  const legacy = (query: string) => legacyNotebookHref(new URLSearchParams(query));

  it("sends old notebook links on the device page to the workspace, keeping the entry", () => {
    expect(legacy("id=d1&tab=notebook")).toBe("/devices/notebook?id=d1");
    expect(legacy("id=d1&tab=notebook&entry=e1")).toBe("/devices/notebook?id=d1&entry=e1");
  });

  it("leaves every other device page link alone", () => {
    expect(legacy("id=d1")).toBeNull();
    expect(legacy("id=d1&tab=images")).toBeNull();
    expect(legacy("id=d1&tab=cves&cve=c1")).toBeNull();
    expect(legacy("tab=notebook")).toBeNull();
  });
});

describe("cveHref", () => {
  it("still links to the Vulnerabilities CVE page", () => {
    expect(cveHref("c1")).toBe("/vulnerabilities/view?id=c1");
    expect(cveHref("c1", "devices", { edit: true })).toBe("/vulnerabilities/view?id=c1&tab=devices&edit=1");
  });
});
