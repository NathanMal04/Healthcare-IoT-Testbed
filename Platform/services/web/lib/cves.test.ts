import { describe, expect, it, vi } from "vitest";

// lib/api pulls in Amplify; the pure logic only needs ApiError, so the module
// is replaced with a stand-in that has the same shape.
vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    readonly status: number;
    readonly details: Record<string, unknown>;
    constructor(message: string, status: number, details: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  return { ApiError, apiRequest: vi.fn() };
});

import { ApiError } from "@/lib/api";
import {
  EMPTY_CVE_FORM,
  EMPTY_FILTERS,
  NO_DEVICES,
  addChipsets,
  createCveWithDevices,
  cveChanges,
  cveFormValues,
  cveIdError,
  descriptionPreview,
  duplicateCveRecordId,
  filterCves,
  isWebUrl,
  linkDevices,
  normalizeCveId,
  toNewCve,
  validateCveForm,
  type Cve,
  type CveFormValues,
  type CveWriteApi,
  type NewCve,
} from "@/lib/cves";

const NOW = new Date("2026-10-05T12:00:00Z");

function cve(overrides: Partial<Cve> = {}): Cve {
  return {
    cveRecordId: "rec-1",
    cveId: "CVE-2021-37584",
    severity: "high",
    cvssScore: 8.2,
    cvssVersion: "3.1",
    description: "WPS / IEEE 1905 mishandling resulting in out-of-bounds write/read.",
    affectedChipsets: ["MT7610UN", "MT7612UN"],
    references: [],
    deviceIds: [],
    createdBy: "user-1",
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
    version: 1,
    ...overrides,
  };
}

function form(overrides: Partial<CveFormValues> = {}): CveFormValues {
  return { ...EMPTY_CVE_FORM, cveId: "CVE-2021-37584", severity: "high", ...overrides };
}

// --- normalizeCveId / cveIdError ---------------------------------------------------

describe("normalizeCveId", () => {
  it("trims and uppercases", () => {
    expect(normalizeCveId("  cve-2021-37584 ")).toBe("CVE-2021-37584");
  });

  it("turns Unicode hyphens into ASCII", () => {
    for (const hyphen of ["‐", "‑", "‒", "–", "—", "―", "−"]) {
      expect(normalizeCveId(`CVE${hyphen}2021${hyphen}37584`)).toBe("CVE-2021-37584");
    }
  });

  it("accepts valid ids, including long sequence numbers", () => {
    expect(cveIdError("cve-2020-26652", NOW)).toBeNull();
    expect(cveIdError("CVE–2021–37584", NOW)).toBeNull();
    expect(cveIdError("CVE-2021-1234567", NOW)).toBeNull();
    expect(cveIdError("CVE-2027-0001", NOW)).toBeNull();
  });

  it("rejects invalid ids", () => {
    for (const raw of ["", "  ", "CVE-2021", "CVE-2021-123", "CVE_2021_37584", "2021-37584", "CVE-2021-37584x",
                       "CVE 2021 37584", "CVE-2021-３７５８４"]) {
      expect(cveIdError(raw, NOW), raw).not.toBeNull();
    }
  });

  it("rejects years outside 1999..next year", () => {
    expect(cveIdError("CVE-1998-0001", NOW)).toMatch(/year/);
    expect(cveIdError("CVE-2028-0001", NOW)).toMatch(/year/);
  });
});

// --- validateCveForm -----------------------------------------------------------------

describe("validateCveForm", () => {
  const validate = (values: CveFormValues, mode: "create" | "edit" = "create") =>
    validateCveForm(values, { mode, now: NOW });

  it("accepts Justin's examples", () => {
    expect(validate(form({ cvssScore: "8.2", cvssVersion: "3.1", affectedChipsets: ["MT7610UN", "MT7612UN"] }))).toEqual({});
    expect(validate(form({ cveId: "CVE-2020-26652", cvssScore: "7.5", affectedChipsets: ["RTL8812AU"] }))).toEqual({});
  });

  it("requires CVE ID (on create) and severity", () => {
    const errors = validate(form({ cveId: "", severity: "" }));
    expect(errors.cveId).toBeDefined();
    expect(errors.severity).toBeDefined();
    // The CVE ID is read-only when editing, so it isn't checked.
    expect(validate(form({ cveId: "" }), "edit").cveId).toBeUndefined();
  });

  it("checks CVSS boundaries without rounding", () => {
    for (const score of ["", "0", "0.0", "10", "10.0", "8.25", "9.99999", ".5"]) {
      expect(validate(form({ cvssScore: score })).cvssScore, score).toBeUndefined();
    }
    for (const score of ["-0.1", "10.1", "11", "abc", "8,2", "1e1", "0x5", "Infinity", "NaN"]) {
      expect(validate(form({ cvssScore: score })).cvssScore, score).toBeDefined();
    }
  });

  it("checks references", () => {
    expect(validate(form({ references: ["https://nvd.nist.gov/a", "http://example.com/b", "  "] })).references).toBeUndefined();
    for (const bad of ["javascript:alert(1)", "ftp://x.com", "example.com", "https://", "https:example.com",
                       "https://exa mple.com"]) {
      expect(validate(form({ references: [bad] })).references, bad).toBeDefined();
    }
    const many = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
    expect(validate(form({ references: many })).references).toMatch(/At most 20/);
  });

  it("checks chipsets", () => {
    expect(validate(form({ affectedChipsets: Array.from({ length: 20 }, (_, i) => `C${i}`) })).affectedChipsets).toBeUndefined();
    expect(validate(form({ affectedChipsets: Array.from({ length: 21 }, (_, i) => `C${i}`) })).affectedChipsets).toBeDefined();
    expect(validate(form({ affectedChipsets: ["x".repeat(65)] })).affectedChipsets).toBeDefined();
  });

  it("checks description length and device count", () => {
    expect(validate(form({ description: "x".repeat(4000) })).description).toBeUndefined();
    expect(validate(form({ description: "x".repeat(4001) })).description).toBeDefined();
    expect(validate(form({ deviceIds: Array.from({ length: 41 }, (_, i) => `d${i}`) })).deviceIds).toBeDefined();
  });
});

describe("form helpers", () => {
  it("adds chipsets trimmed and de-duplicated case-insensitively", () => {
    expect(addChipsets(["MT7610UN"], " mt7610un, MT7612UN ,, RTL8812AU")).toEqual(["MT7610UN", "MT7612UN", "RTL8812AU"]);
  });

  it("isWebUrl matches the backend's rule", () => {
    expect(isWebUrl("https://nvd.nist.gov/vuln/detail/CVE-2021-37584")).toBe(true);
    expect(isWebUrl("data:text/html,x")).toBe(false);
  });

  it("builds the POST body with only filled fields and a canonical id", () => {
    const input = toNewCve(
      form({ cveId: " cve–2021-37584 ", cvssScore: "8.2", cvssVersion: "3.1", description: "  d  ",
             affectedChipsets: ["MT7610UN", "mt7610un"], references: [" https://a.com ", "", "https://a.com"],
             deviceIds: ["dev-1"] }),
      "ws-1"
    );
    expect(input).toEqual({
      cveId: "CVE-2021-37584", severity: "high", cvssScore: 8.2, cvssVersion: "3.1", description: "d",
      affectedChipsets: ["MT7610UN"], references: ["https://a.com"], workspaceId: "ws-1",
    });
    expect(input).not.toHaveProperty("deviceIds");
    expect(toNewCve(form())).toEqual({ cveId: "CVE-2021-37584", severity: "high" });
  });

  it("builds a PATCH with only changed fields, null to clear, never deviceIds", () => {
    const original = cve({ deviceIds: ["dev-1"], references: ["https://a.com"] });
    expect(cveChanges(original, cveFormValues(original))).toEqual({});
    const edited = { ...cveFormValues(original), severity: "critical" as const, cvssScore: "", cvssVersion: "" as const,
                     description: "  ", affectedChipsets: [], references: ["https://a.com", "https://b.com"],
                     deviceIds: [] };
    const changes = cveChanges(original, edited);
    expect(changes).toEqual({
      severity: "critical", cvssScore: null, cvssVersion: null, description: null, affectedChipsets: null,
      references: ["https://a.com", "https://b.com"],
    });
    expect(changes).not.toHaveProperty("deviceIds");
  });
});

// --- filterCves --------------------------------------------------------------------

describe("filterCves", () => {
  const names = new Map([["dev-pump", "Infusion Pump X100"], ["dev-icu", "ICU Heart Monitor"]]);
  const a = cve({ cveRecordId: "a", deviceIds: ["dev-pump"] });
  const b = cve({ cveRecordId: "b", cveId: "CVE-2020-26652", severity: "high", cvssScore: 7.5,
                  description: "DoS in rtl80211_send_chandef, network-adjacent.", affectedChipsets: ["RTL8812AU"],
                  deviceIds: ["dev-icu", "dev-pump"] });
  const c = cve({ cveRecordId: "c", cveId: "CVE-2022-26445", severity: "medium", description: null,
                  affectedChipsets: [], deviceIds: [] });
  const all = [a, b, c];
  const ids = (text: string, extra: Partial<typeof EMPTY_FILTERS> = {}) =>
    filterCves(all, { ...EMPTY_FILTERS, text, ...extra }, names).map((x) => x.cveRecordId);

  it("returns everything with no filters, in order", () => {
    expect(ids("")).toEqual(["a", "b", "c"]);
  });

  it("searches the CVE ID, case- and hyphen-insensitively", () => {
    expect(ids("cve-2020-26652")).toEqual(["b"]);
    expect(ids("CVE–2022")).toEqual(["c"]);
    expect(ids("37584")).toEqual(["a"]);
  });

  it("searches the description", () => {
    expect(ids("chandef")).toEqual(["b"]);
    expect(ids("out-of-bounds")).toEqual(["a"]);
  });

  it("searches chipsets", () => {
    expect(ids("rtl8812")).toEqual(["b"]);
    expect(ids("MT7612UN")).toEqual(["a"]);
  });

  it("searches linked device names", () => {
    expect(ids("infusion pump")).toEqual(["a", "b"]);
    expect(ids("icu")).toEqual(["b"]);
  });

  it("requires every word to match", () => {
    expect(ids("icu rtl8812au")).toEqual(["b"]);
    expect(ids("icu mt7610un")).toEqual([]);
  });

  it("filters by severity separately from text", () => {
    expect(ids("", { severity: "medium" })).toEqual(["c"]);
    expect(ids("high", { severity: "" })).toEqual([]); // severity isn't free text
  });

  it("filters by a specific device", () => {
    expect(ids("", { device: "dev-icu" })).toEqual(["b"]);
    expect(ids("", { device: "dev-pump" })).toEqual(["a", "b"]);
  });

  it("filters CVEs with no devices, including deviceIds []", () => {
    expect(ids("", { device: NO_DEVICES })).toEqual(["c"]);
  });

  it("never matches a raw device id or an unresolved device", () => {
    expect(ids("dev-pump")).toEqual([]);
    const unknown = filterCves([cve({ deviceIds: ["dev-gone"] })], { ...EMPTY_FILTERS, text: "unknown" }, names);
    expect(unknown).toEqual([]);
  });
});

// --- createCveWithDevices ------------------------------------------------------------

describe("descriptionPreview", () => {
  const long =
    "This vulnerability exists in the RTL8811AU driver where specially crafted packets may cause a Buffer Overflow " +
    "in the wireless stack, allowing remote attackers to execute code. " +
    "Further details describe the affected firmware versions and mitigations in considerable length.";
  const render = (p: ReturnType<typeof descriptionPreview>) =>
    p && (p.leading ? "…" : "") + p.parts.map((x) => (x.match ? `[${x.text}]` : x.text)).join("") + (p.trailing ? "…" : "");

  it("is null without a description", () => {
    expect(descriptionPreview(null, "")).toBeNull();
    expect(descriptionPreview("   ", "x")).toBeNull();
  });

  it("shows the start, collapsing whitespace, when there is no search", () => {
    const p = descriptionPreview("Short\n\n  text", "");
    expect(render(p)).toBe("Short text");
    expect(descriptionPreview(long, "")!.leading).toBe(false);
    expect(descriptionPreview(long, "")!.trailing).toBe(true);
  });

  it("centres on a match deep in the text and highlights it, ignoring case", () => {
    const out = render(descriptionPreview(long, "buffer overflow"))!;
    expect(out.startsWith("…")).toBe(true);
    expect(out).toContain("[Buffer Overflow]");
    expect(out.endsWith("…")).toBe(true);
    // Starts on a word boundary close before the match.
    expect(out).toMatch(/^…[A-Za-z]/);
    expect(out.indexOf("[Buffer")).toBeLessThan(40);
  });

  it("highlights each word when the whole phrase isn't there", () => {
    const out = render(descriptionPreview("Remote attackers send crafted packets", "packets remote"))!;
    expect(out).toBe("[Remote] attackers send crafted [packets]");
  });

  it("keeps the normal start when the query matches elsewhere (CVE ID, chipset, device)", () => {
    const p = descriptionPreview(long, "CVE-2025-8302");
    expect(p!.leading).toBe(false);
    expect(p!.parts.every((x) => !x.match)).toBe(true);
  });

  it("matches hyphen variants the way the search does", () => {
    expect(render(descriptionPreview("A use‑after‑free bug", "use-after-free"))).toBe("A [use‑after‑free] bug");
  });
});

describe("createCveWithDevices", () => {
  const input: NewCve = { cveId: "CVE-2021-37584", severity: "high" };

  function fakeApi(failing: Record<string, Error> = {}) {
    const linked: string[] = [];
    const api: CveWriteApi = {
      createCve: vi.fn(async () => cve({ cveRecordId: "new" })),
      linkCveDevice: vi.fn(async (rid: string, deviceId: string) => {
        if (failing[deviceId]) throw failing[deviceId];
        linked.push(deviceId);
        return { cve: cve({ cveRecordId: rid, deviceIds: [...linked] }), changed: true };
      }),
    };
    return api;
  }

  it("creates only when no devices are chosen", async () => {
    const api = fakeApi();
    const result = await createCveWithDevices(input, [], { api });
    expect(result).toEqual({ cve: cve({ cveRecordId: "new" }), failed: [] });
    expect(api.linkCveDevice).not.toHaveBeenCalled();
    // deviceIds are never sent to POST.
    expect(api.createCve).toHaveBeenCalledWith(input);
  });

  it("links every device in order, one at a time", async () => {
    const api = fakeApi();
    const progress: Array<[number, number]> = [];
    const result = await createCveWithDevices(input, ["d1", "d2", "d1"], {
      api,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(result.failed).toEqual([]);
    expect(result.cve.deviceIds).toEqual(["d1", "d2"]);
    expect((api.linkCveDevice as ReturnType<typeof vi.fn>).mock.calls).toEqual([["new", "d1"], ["new", "d2"]]);
    expect(progress).toEqual([[0, 2], [1, 2], [2, 2]]);
  });

  it("keeps the CVE and reports links that failed", async () => {
    const api = fakeApi({
      d2: new ApiError("Device not found", 404),
      d3: new ApiError("Internal error", 500),
    });
    const result = await createCveWithDevices(input, ["d1", "d2", "d3", "d4"], { api });
    expect(result.cve.cveRecordId).toBe("new");
    expect(result.cve.deviceIds).toEqual(["d1", "d4"]);
    expect(result.failed).toEqual([
      { deviceId: "d2", message: "Device not found" },
      { deviceId: "d3", message: "Couldn't reach the server" },
    ]);
  });

  it("retries only the failed links, keeping the last known CVE", async () => {
    const api = fakeApi();
    const created = cve({ cveRecordId: "new", deviceIds: ["d1"] });
    const retried = await linkDevices("new", ["d2"], { api, cve: created });
    expect(retried.failed).toEqual([]);
    expect((api.linkCveDevice as ReturnType<typeof vi.fn>).mock.calls).toEqual([["new", "d2"]]);
  });

  it("throws when creation fails, and links nothing", async () => {
    const api = fakeApi();
    api.createCve = vi.fn(async () => {
      throw new ApiError("severity must be one of: low, medium, high, critical", 400);
    });
    await expect(createCveWithDevices(input, ["d1"], { api })).rejects.toThrow(/severity/);
    expect(api.linkCveDevice).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate with the existing record's id", async () => {
    const api = fakeApi();
    api.createCve = vi.fn(async () => {
      throw new ApiError("CVE-2021-37584 is already recorded in this scope", 409, {
        error: "CVE-2021-37584 is already recorded in this scope",
        cveId: "CVE-2021-37584",
        cveRecordId: "existing-1",
      });
    });
    const err = await createCveWithDevices(input, ["d1"], { api }).catch((e) => e);
    expect(duplicateCveRecordId(err)).toBe("existing-1");
    expect(api.linkCveDevice).not.toHaveBeenCalled();
    // Other 409s (e.g. the 40-device limit) aren't duplicates.
    expect(duplicateCveRecordId(new ApiError("A CVE can be linked to at most 40 devices", 409))).toBeNull();
  });
});
