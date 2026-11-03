// @vitest-environment jsdom
// The Overview's cards, rendered with controlled data: real-data figures,
// partial counts, missing values, permissions, and each card's own loading,
// error and empty states. (Loading on the page itself: DeviceViewPage.test.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const views = vi.hoisted(() => ({
  urls: {} as Record<string, { status: string; url?: string; error?: string }>,
  broken: new Set<string>(),
  error: null as string | null,
  retry: vi.fn(),
  reportError: vi.fn(),
  requested: [] as string[][],
}));
vi.mock("@/app/components/images/useImageData", () => ({
  useImageUrls: (ids: string[]) => {
    views.requested.push(ids);
    return {
      get: (id: string) => views.urls[id],
      isBroken: (id: string) => views.broken.has(id),
      error: views.error,
      retry: views.retry,
      reportError: views.reportError,
      ensure: () => undefined,
      refresh: () => undefined,
      problemCount: 0,
    };
  },
}));

const explorer = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/app/components/CveLinkExplorer", () => ({
  default: (props: Record<string, unknown>) => {
    explorer.props = props;
    return <div role="dialog" aria-label="Link CVEs dialog" />;
  },
}));

vi.mock("@/lib/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/devices")>()),
  updateDeviceReverseEngineeringStatus: vi.fn(),
}));

import OverviewSection from "./sections/OverviewSection";
import type { Device } from "@/lib/devices";
import type { Artifact, ArtifactPage } from "@/lib/artifacts";
import type { CveSummary } from "@/lib/cves";
import type { ImageArtifact } from "@/lib/images";
import type { Notebook, NotebookEntry } from "@/lib/reNotebook";
import type { DeviceCves } from "./useDeviceCves";
import type { Loadable, OverviewData } from "./useOverviewData";
import { axeViolations } from "@/app/components/ui/testing/axe";

const ID = "d-1";
const view = (extra = "") => `/devices/view?id=${ID}${extra}`;

const DEVICE: Device = {
  deviceId: ID,
  name: "InfuMax Pump",
  type: "Infusion pump",
  role: "member",
  workspaceId: "ws-1",
  reverseEngineeringStatus: "in_progress",
  manufacturer: "InfuMax",
  modelNumber: "IMX-300",
  chipset: "nRF52840",
  serialNumber: "SN-1",
  hardwareRevision: "Rev C",
  firmwareVersion: "4.2.1",
  description: "Volumetric pump",
  createdAt: "2026-09-02T10:00:00Z",
  updatedAt: "2026-10-30T10:00:00Z",
};

const fw = (id: string, re: string | undefined, status = "ready") =>
  ({ artifactId: id, type: "firmware", status, reverseEngineeringStatus: re }) as unknown as Artifact;
const FIRMWARE = [fw("f1", "complete"), fw("f2", "complete"), fw("f3", "in_progress"), fw("f4", undefined, "failed"), fw("f5", "not_started")];

const cve = (n: number, severity: string, cvssScore: number | null, deviceIds = [ID]): CveSummary => ({
  cveRecordId: `r-${n}`,
  cveId: `CVE-2026-000${n}`,
  severity: severity as CveSummary["severity"],
  cvssScore,
  cvssVersion: cvssScore === null ? null : "3.1",
  description: `Issue ${n}`,
  affectedChipsets: [],
  deviceIds,
  createdBy: "u",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: `2026-01-0${n}T00:00:00Z`,
  version: 1,
});

function cvesState(patch: Partial<DeviceCves> = {}): DeviceCves {
  const all = [cve(1, "low", 3.1), cve(2, "critical", 9.8), cve(3, "high", null), cve(4, "medium", 5), cve(5, "high", 7.5), cve(6, "high", 8.1), cve(7, "medium", 4), cve(8, "critical", 9.1, ["other"])];
  return {
    cves: all,
    deviceCves: all.filter((c) => c.deviceIds.includes(ID)),
    error: null,
    loading: false,
    scopeDevices: [DEVICE],
    scopeDevicesError: null,
    load: vi.fn(async () => undefined),
    upsert: vi.fn(),
    remove: vi.fn(),
    ...patch,
  };
}

function loadable<T>(data: T | null, patch: Partial<Loadable<T>> = {}): Loadable<T> {
  return { data, loading: false, error: null, forbidden: false, reload: vi.fn(), ...patch };
}

const entry = (id: string, title: string, patch: Partial<NotebookEntry> = {}) =>
  ({
    entryId: id,
    sectionId: "",
    title,
    contentUpdatedAt: null,
    contentUpdatedByName: null,
    updatedAt: null,
    updatedByName: null,
    createdAt: null,
    createdByName: null,
    ...patch,
  }) as NotebookEntry;
const NOTEBOOK = {
  deviceId: ID,
  orderVersion: 1,
  limits: {},
  sections: [
    {
      sectionId: "hw",
      title: "Hardware",
      entries: [
        entry("uart", "UART pinout", { contentUpdatedAt: "2026-10-30T09:00:00Z", contentUpdatedByName: "Grace" }),
        entry("bare", "Untimed note"),
      ],
    },
    { sectionId: "fw", title: "Firmware", entries: [entry("boot", "Bootloader", { createdAt: "2026-10-01T09:00:00Z" })] },
    { sectionId: "empty", title: "Empty", entries: [] },
  ],
} as unknown as Notebook;

const img = (id: string, status = "ready") => ({ artifactId: id, title: `Photo ${id}`, name: `${id}.jpg`, status }) as ImageArtifact;

function overviewData(patch: Partial<OverviewData> = {}): OverviewData {
  return {
    artifacts: loadable({ artifacts: [{ type: "binary" }, { type: "pcap" }, { type: "firmware" }, { type: "image" }] as Artifact[] }),
    images: loadable({ images: [img("i1"), img("i2"), img("i3", "pending"), img("i4"), img("i5"), img("i6")] }),
    notebook: loadable(NOTEBOOK),
    ...patch,
  };
}

interface Props {
  device?: Device;
  canEdit?: boolean;
  firmware?: Artifact[] | null;
  firmwareError?: string | null;
  cves?: DeviceCves;
  overview?: OverviewData;
}
const onEdit = vi.fn();
const reloadFirmware = vi.fn();
function renderOverview(props: Props = {}) {
  return render(
    <OverviewSection
      device={props.device ?? DEVICE}
      canEdit={props.canEdit ?? true}
      firmware={props.firmware === undefined ? FIRMWARE : props.firmware}
      firmwareError={props.firmwareError ?? null}
      reloadFirmware={reloadFirmware}
      cves={props.cves ?? cvesState()}
      overview={props.overview ?? overviewData()}
      onDeviceChange={() => undefined}
      onEdit={onEdit}
    />
  );
}

const card = (title: string) => {
  const heading = screen.getByRole("heading", { name: title });
  return within(heading.closest(".bg-white, [class*='rounded-xl']") as HTMLElement);
};
const glance = () => within(screen.getByRole("region", { name: "At a glance" }));
const tileText = () => glance().getAllByRole("link").map((a) => a.querySelector(".sr-only")?.textContent);

beforeEach(() => {
  views.urls = {};
  views.broken = new Set();
  views.error = null;
  views.requested = [];
  views.retry.mockReset();
  explorer.props = null;
  onEdit.mockReset();
  reloadFirmware.mockReset();
});
afterEach(cleanup);

// --- At a glance --------------------------------------------------------------------

describe("At a glance", () => {
  it("shows exact counts from real records, each linking to its section", () => {
    renderOverview();
    expect(glance().getAllByRole("link").map((a) => [a.querySelector(".sr-only")?.textContent, a.getAttribute("href")])).toEqual([
      ["Firmware versions: 5", view("&tab=firmware")],
      ["Linked vulnerabilities: 7", view("&tab=cves")],
      ["Images: 6", view("&tab=images")],
      ["Other files: 2", view("&tab=artifacts")],
    ]);
    expect(glance().getByText("2 RE complete · 1 upload not ready")).toBeTruthy();
    expect(glance().getByText("1 critical · 3 high")).toBeTruthy();
    expect(glance().getByText("Excluding firmware and images")).toBeTruthy();
  });

  it("marks counts from a page with more as lower bounds", () => {
    renderOverview({
      overview: overviewData({
        artifacts: loadable({ artifacts: [{ type: "log" }] as Artifact[], nextToken: "t" }),
        images: loadable({ images: [img("i1")], nextToken: "t" }),
      }),
    });
    expect(tileText()).toEqual([
      "Firmware versions: 5",
      "Linked vulnerabilities: 7",
      "Images: at least 1",
      "Other files: at least 1",
    ]);
    expect(glance().getAllByText("1+")).toHaveLength(2);
    expect(glance().getByText("More in Images")).toBeTruthy();
  });

  it("shows loading placeholders, then failures with a retry per count", () => {
    const overview = overviewData({
      images: loadable<{ images: ImageArtifact[] }>(null),
      artifacts: loadable<ArtifactPage>(null, { error: "Files down" }),
    });
    renderOverview({ firmware: null, firmwareError: "Firmware down", cves: cvesState({ cves: null, deviceCves: [] }), overview });
    expect(tileText()).toEqual([
      "Firmware versions: couldn't be loaded",
      "Linked vulnerabilities: loading",
      "Images: loading",
      "Other files: couldn't be loaded",
    ]);
    fireEvent.click(glance().getByRole("button", { name: "Retry firmware versions" }));
    expect(reloadFirmware).toHaveBeenCalled();
    fireEvent.click(glance().getByRole("button", { name: "Retry other files" }));
    expect(overview.artifacts.reload).toHaveBeenCalled();
  });

  it("says when nothing is linked or uploaded", () => {
    renderOverview({ firmware: [], cves: cvesState({ cves: [], deviceCves: [] }) });
    expect(glance().getByText("None uploaded")).toBeTruthy();
    expect(glance().getByText("None linked")).toBeTruthy();
  });
});

// --- Research status ------------------------------------------------------------------

describe("Research status", () => {
  it("shows the device status and the firmware breakdown, without a percentage", () => {
    renderOverview();
    const research = card("Research status");
    expect((research.getByLabelText("Reverse-engineering status for InfuMax Pump") as HTMLSelectElement).value).toBe("in_progress");
    expect(research.getByText("Reverse engineering complete for 2 of 5 firmware versions")).toBeTruthy();
    const legend = research.getByRole("list", { name: "Firmware investigation" });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Not Started2",
      "In-Progress1",
      "Complete2",
    ]);
    expect(research.getByText(/Upload status: 1 version isn't ready yet \(pending, verifying or\s+failed\)\./)).toBeTruthy();
    expect(research.getByRole("link", { name: /View firmware/ }).getAttribute("href")).toBe(view("&tab=firmware"));
    expect(screen.getByRole("heading", { name: "Research status" }).closest("div")!.parentElement!.textContent).not.toContain("%");
  });

  it("handles no firmware, loading and a failed load", () => {
    renderOverview({ firmware: [] });
    expect(card("Research status").getByText("No firmware uploaded yet.")).toBeTruthy();
    cleanup();
    renderOverview({ firmware: null, firmwareError: "Firmware down" });
    expect(card("Research status").getByText("Couldn't load firmware: Firmware down")).toBeTruthy();
  });
});

// --- Specifications ---------------------------------------------------------------------

describe("Specifications", () => {
  it("lists every field, the dates when known, and lets editors edit", () => {
    renderOverview();
    const specs = card("Specifications");
    // The only description list on the Overview.
    expect(document.querySelectorAll("dl")).toHaveLength(1);
    const rows = Array.from(document.querySelectorAll("dl dt")).map(
      (dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`
    );
    expect(rows.slice(0, 8)).toEqual([
      "Manufacturer: InfuMax",
      "Model: IMX-300",
      "Device type: Infusion pump",
      "Chipset: nRF52840",
      "Serial number: SN-1",
      "Hardware revision: Rev C",
      "Reported firmware version: 4.2.1",
      "Description: Volumetric pump",
    ]);
    expect(rows.slice(8).map((r) => r.split(":")[0])).toEqual(["Added", "Last updated"]);
    expect(specs.queryByText(/not recorded/)).toBeNull();
    fireEvent.click(specs.getByRole("button", { name: "Edit details" }));
    expect(onEdit).toHaveBeenCalled();
  });

  it("says what isn't recorded, and offers no edit to viewers", () => {
    renderOverview({
      device: { deviceId: ID, name: "Bare", role: "viewer", workspaceId: "ws-1", reverseEngineeringStatus: "not_started" },
      canEdit: false,
    });
    const specs = card("Specifications");
    expect(specs.getAllByText("Not recorded")).toHaveLength(8);
    expect(specs.getByText("8 of 8 details not recorded")).toBeTruthy();
    expect(specs.queryByRole("button", { name: "Edit details" })).toBeNull();
    expect(specs.queryByText("Added")).toBeNull();
  });
});

// --- Linked vulnerabilities --------------------------------------------------------------

describe("Linked vulnerabilities", () => {
  it("shows the severity spread and the most severe CVEs, each opening inside the device", () => {
    renderOverview();
    const vulns = card("Linked vulnerabilities");
    expect(vulns.getByText("7 linked to this device")).toBeTruthy();
    const spread = vulns.getByRole("list", { name: "Linked CVEs by severity" });
    expect(within(spread).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Critical1", "High3", "Medium2", "Low1"]);
    const links = vulns.getAllByRole("link").filter((a) => a.getAttribute("href")?.includes("cve="));
    expect(links.map((a) => [a.querySelector(".font-mono")?.textContent, a.getAttribute("href")])).toEqual([
      ["CVE-2026-0002", view("&tab=cves&cve=r-2")],
      ["CVE-2026-0006", view("&tab=cves&cve=r-6")],
      ["CVE-2026-0005", view("&tab=cves&cve=r-5")],
      ["CVE-2026-0003", view("&tab=cves&cve=r-3")],
      ["CVE-2026-0004", view("&tab=cves&cve=r-4")],
    ]);
    expect(links[0].textContent).toContain("CVSS 9.8 v3.1");
    expect(links[3].textContent).toContain("No CVSS score");
    expect(vulns.getByText(/Showing the 5 most severe of 7/)).toBeTruthy();
    expect(vulns.getAllByRole("link", { name: "View all" }).map((a) => a.getAttribute("href"))).toEqual([view("&tab=cves"), view("&tab=cves")]);
  });

  it("links CVEs through the existing explorer, for users who may", () => {
    const cves = cvesState();
    renderOverview({ cves });
    fireEvent.click(card("Linked vulnerabilities").getByRole("button", { name: "Link CVEs" }));
    expect(screen.getByRole("dialog", { name: "Link CVEs dialog" })).toBeTruthy();
    expect(explorer.props!.cves).toBe(cves.cves);
    act(() => (explorer.props!.onLinked as (c: unknown[]) => void)([{ cveRecordId: "r-8" }]));
    expect(cves.upsert).toHaveBeenCalledWith({ cveRecordId: "r-8" });
    act(() => (explorer.props!.onDone as (n: number) => void)(1));
    expect(screen.queryByRole("dialog", { name: "Link CVEs dialog" })).toBeNull();
    expect(screen.getByText("Linked 1 CVE to InfuMax Pump.")).toBeTruthy();
  });

  it("offers no Link CVEs to viewers, and says when none are linked", () => {
    renderOverview({ canEdit: false, cves: cvesState({ deviceCves: [] }) });
    const vulns = card("Linked vulnerabilities");
    expect(vulns.queryByRole("button", { name: "Link CVEs" })).toBeNull();
    expect(vulns.getByText("No CVEs linked to this device.")).toBeTruthy();
    expect(vulns.getByRole("link", { name: "View all" })).toBeTruthy();
  });

  it("shows a failed load with a retry, and a placeholder while loading", () => {
    const cves = cvesState({ cves: null, deviceCves: [], error: "CVEs down" });
    renderOverview({ cves });
    const vulns = card("Linked vulnerabilities");
    expect(vulns.getByText("CVEs down")).toBeTruthy();
    fireEvent.click(vulns.getByRole("button", { name: "Retry" }));
    expect(cves.load).toHaveBeenCalled();
    expect((vulns.getByRole("button", { name: "Link CVEs" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// --- RE Notebook ----------------------------------------------------------------------------

describe("RE Notebook activity", () => {
  it("counts sections and entries and links recent entries into the full-screen notebook", () => {
    renderOverview();
    const nb = card("RE Notebook activity");
    expect(nb.getByText("3 sections · 3 entries")).toBeTruthy();
    expect(nb.getByRole("link", { name: "Open notebook" }).getAttribute("href")).toBe(`/devices/notebook?id=${ID}`);
    const entries = nb.getAllByRole("link").filter((a) => a.getAttribute("href")?.includes("entry="));
    expect(entries.map((a) => a.getAttribute("href"))).toEqual([
      `/devices/notebook?id=${ID}&section=hw&entry=uart`,
      `/devices/notebook?id=${ID}&section=fw&entry=boot`,
      `/devices/notebook?id=${ID}&section=hw&entry=bare`,
    ]);
    // Name and time only where the notebook records them.
    expect(entries[0].textContent).toContain("UART pinout");
    expect(entries[0].textContent).toContain("Hardware · Grace · ");
    expect(entries[0].querySelector("time")!.getAttribute("dateTime")).toBe("2026-10-30T09:00:00Z");
    expect(entries[1].textContent).not.toContain(" · Grace");
    expect(entries[1].querySelector("time")).toBeTruthy();
    expect(entries[2].textContent).toBe("Untimed noteHardware");
    expect(entries[2].querySelector("time")).toBeNull();
  });

  it("handles an empty notebook, no access, a failure and loading", () => {
    renderOverview({ overview: overviewData({ notebook: loadable({ ...NOTEBOOK, sections: [] } as Notebook) }) });
    expect(card("RE Notebook activity").getByText(/No entries yet/)).toBeTruthy();
    expect(card("RE Notebook activity").getByRole("link", { name: "Start the notebook" }).getAttribute("href")).toBe(
      `/devices/notebook?id=${ID}`
    );
    cleanup();

    renderOverview({ overview: overviewData({ notebook: loadable<Notebook>(null, { forbidden: true, error: "Forbidden" }) }) });
    expect(card("RE Notebook activity").getByText("You don't have access to this device's RE Notebook.")).toBeTruthy();
    expect(card("RE Notebook activity").queryByRole("link", { name: "Open notebook" })).toBeNull();
    cleanup();

    const notebook = loadable<Notebook>(null, { error: "Notebook down" });
    renderOverview({ overview: overviewData({ notebook }) });
    fireEvent.click(card("RE Notebook activity").getByRole("button", { name: "Retry" }));
    expect(notebook.reload).toHaveBeenCalled();
    cleanup();

    renderOverview({ overview: overviewData({ notebook: loadable<Notebook>(null, { loading: true }) }) });
    expect(card("RE Notebook activity").queryByRole("list")).toBeNull();
  });
});

// --- Images ---------------------------------------------------------------------------------

describe("Recent images", () => {
  it("previews the newest ready images through the shared view URLs, each opening Images", () => {
    views.urls = {
      i1: { status: "ready", url: "https://s3/i1" },
      i2: { status: "unavailable", error: "gone" },
      i4: { status: "loading" },
    };
    views.broken = new Set(["i5"]);
    renderOverview();
    const images = card("Recent images");
    expect(views.requested.at(-1)).toEqual(["i1", "i2", "i4", "i5"]);
    const thumbs = images.getAllByRole("link").filter((a) => a.getAttribute("title"));
    expect(thumbs.map((a) => a.getAttribute("href"))).toEqual(Array(4).fill(view("&tab=images")));
    expect((images.getByRole("img", { name: "Photo i1" }) as HTMLImageElement).src).toBe("https://s3/i1");
    expect(images.getByText("Photo i2: preview unavailable")).toBeTruthy();
    expect(images.getByText("Photo i4: loading preview")).toBeTruthy();
    expect(images.getByText("Photo i5: preview unavailable")).toBeTruthy();
    fireEvent.error(images.getByRole("img", { name: "Photo i1" }));
    expect(views.reportError).toHaveBeenCalledWith("i1");
    expect(images.getByText("6 images")).toBeTruthy();
  });

  it("says when there are none, when none is ready, and when loading fails", () => {
    renderOverview({ overview: overviewData({ images: loadable({ images: [] }) }) });
    expect(card("Recent images").getByText("No images of this device yet.")).toBeTruthy();
    cleanup();
    renderOverview({ overview: overviewData({ images: loadable({ images: [img("p", "pending")], nextToken: "t" }) }) });
    expect(card("Recent images").getByText("None of the newest images is ready to preview yet.")).toBeTruthy();
    expect(card("Recent images").getByText("1+ images")).toBeTruthy();
    cleanup();
    const images = loadable<{ images: ImageArtifact[] }>(null, { error: "Images down" });
    renderOverview({ overview: overviewData({ images }) });
    fireEvent.click(card("Recent images").getByRole("button", { name: "Retry" }));
    expect(images.reload).toHaveBeenCalled();
  });

  it("offers a retry when the preview URLs can't be fetched", () => {
    views.error = "Couldn't load image previews";
    renderOverview();
    fireEvent.click(card("Recent images").getByRole("button", { name: "Retry" }));
    expect(views.retry).toHaveBeenCalled();
  });
});

describe("Overview accessibility", () => {
  it("has no automated accessibility violations", async () => {
    views.urls = { i1: { status: "ready", url: "https://s3/i1" } };
    const { container } = renderOverview();
    expect(await axeViolations(container)).toEqual([]);
  });
});

// --- Data-accuracy review ----------------------------------------------------------------

describe("Overview data accuracy", () => {
  it("counts other files without firmware or images, as a lower bound when the list has more pages", () => {
    const page = [
      { type: "firmware" },
      { type: "image" },
      { type: "image" },
      { type: "binary" },
      { type: "report" },
    ] as Artifact[];
    renderOverview({ overview: overviewData({ artifacts: loadable({ artifacts: page }) }) });
    expect(tileText()[3]).toBe("Other files: 2");
    cleanup();
    renderOverview({ overview: overviewData({ artifacts: loadable({ artifacts: page, nextToken: "more" }) }) });
    expect(tileText()[3]).toBe("Other files: at least 2");
    const tile = glance().getByRole("link", { name: /Other files/ });
    expect(tile.textContent).toContain("2+");
    expect(tile.getAttribute("title")).toBe("Other files: at least 2");
    cleanup();
    // A page of only firmware and images, with more to come: at least 0, not a total.
    renderOverview({
      overview: overviewData({ artifacts: loadable({ artifacts: [{ type: "firmware" }, { type: "image" }] as Artifact[], nextToken: "more" }) }),
    });
    expect(tileText()[3]).toBe("Other files: at least 0");
  });

  it("keeps upload readiness apart from reverse-engineering status", () => {
    // Investigated but its upload failed: complete for RE, and not ready as an upload.
    renderOverview({ firmware: [fw("a", "complete", "failed"), fw("b", "complete"), fw("c", undefined, "verifying")] });
    const research = card("Research status");
    expect(research.getByText("Reverse engineering complete for 2 of 3 firmware versions")).toBeTruthy();
    const legend = within(research.getByRole("list", { name: "Firmware investigation" }));
    expect(legend.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Not Started1", "In-Progress0", "Complete2"]);
    expect(research.getByText(/Upload status: 2 versions aren't ready yet/)).toBeTruthy();
    expect(glance().getByText("2 RE complete · 2 uploads not ready")).toBeTruthy();
  });

  it("shows CVSS scores and versions exactly as recorded", () => {
    const records = [
      { ...cve(1, "high", 7, [ID]), cvssVersion: "3.0" as const },
      { ...cve(2, "critical", 9.8, [ID]), cvssVersion: "4.0" as const },
      { ...cve(3, "medium", null, [ID]), cvssVersion: null },
    ];
    renderOverview({ cves: cvesState({ cves: records, deviceCves: records }) });
    const links = card("Linked vulnerabilities")
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href")?.includes("cve="));
    expect(links.map((a) => a.textContent)).toEqual([
      // (The severity badge capitalises the recorded value with CSS.)
      "CVE-2026-0002criticalCVSS 9.8 v4.0Issue 2",
      "CVE-2026-0001highCVSS 7 v3.0Issue 1",
      "CVE-2026-0003mediumNo CVSS scoreIssue 3",
    ]);
  });

  it("gives viewers no way to change the status, edit details or link CVEs", () => {
    renderOverview({ device: { ...DEVICE, role: "viewer" }, canEdit: false });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByLabelText(/Reverse-engineering status for/)).toBeNull();
    // The status is shown read-only (badge), beside the legend's own "In-Progress".
    expect(card("Research status").getByText(/Reverse-engineering status:/).parentElement!.textContent).toBe(
      "Reverse-engineering status: In-Progress"
    );
    expect(screen.queryByRole("button", { name: "Edit details" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link CVEs" })).toBeNull();
    // Only reads and navigation remain.
    const buttons = screen.queryAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual([]);
  });

  it("links notebook entries with the ids the notebook returned", () => {
    renderOverview();
    const hrefs = card("RE Notebook activity")
      .getAllByRole("link")
      .map((a) => new URL(a.getAttribute("href")!, "https://vzoniq.com"))
      .filter((u) => u.searchParams.get("entry"));
    const ids = new Map(
      NOTEBOOK.sections.flatMap((s) => s.entries.map((e) => [e.entryId, s.sectionId] as const))
    );
    expect(hrefs.length).toBe(3);
    for (const url of hrefs) {
      expect(url.pathname).toBe("/devices/notebook");
      expect(url.searchParams.get("id")).toBe(ID);
      expect(ids.get(url.searchParams.get("entry")!)).toBe(url.searchParams.get("section"));
    }
  });
});
