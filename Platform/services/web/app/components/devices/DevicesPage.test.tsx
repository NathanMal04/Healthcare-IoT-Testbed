// @vitest-environment jsdom
// The Devices page (/devices): summary figures, the list and grid views over
// one data set, search, filters and sorting, the remembered view, inline
// status changes and the empty and error states. The API, the workspace
// context and the dialogs are stubbed; the shared components are real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  usePathname: () => "/devices",
}));
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { userId: "user-1" }, loading: false }),
}));

const workspace = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));
vi.mock("@/context/WorkspaceContext", () => ({
  useWorkspace: () => workspace.state,
  useScopeLock: () => undefined,
}));

const api = vi.hoisted(() => ({
  getDevices: vi.fn(),
  updateDeviceReverseEngineeringStatus: vi.fn(),
  listCves: vi.fn(),
  listDeviceArtifacts: vi.fn(),
}));
vi.mock("@/lib/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/devices")>()),
  getDevices: api.getDevices,
  updateDeviceReverseEngineeringStatus: api.updateDeviceReverseEngineeringStatus,
}));
vi.mock("@/lib/cves", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cves")>()),
  listCves: api.listCves,
}));
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  listDeviceArtifacts: api.listDeviceArtifacts,
}));

// One device has a picture with a ready URL; the rest have none.
const IMAGE_ID = "0192a000-0000-7000-8000-0000000000aa";
vi.mock("@/app/components/images/useImageData", () => ({
  useImageUrls: () => ({
    get: (id: string) =>
      id === IMAGE_ID ? { status: "ready", url: "https://images.example/pump.png", expiresAt: Date.now() + 60_000, stale: false } : undefined,
    ensure: () => undefined,
    reportError: () => undefined,
    isBroken: () => false,
    problemCount: 0,
    error: null,
    retry: () => undefined,
    refresh: () => undefined,
  }),
}));

const dialogs = vi.hoisted(() => ({ props: {} as Record<string, Record<string, unknown>> }));
function stub(name: string) {
  return {
    default: (props: Record<string, unknown>) => {
      dialogs.props[name] = props;
      return <div role="dialog" aria-label={name} />;
    },
  };
}
vi.mock("@/app/components/AddDeviceDialog", () => stub("Add device"));
vi.mock("@/app/components/EditDeviceDialog", () => stub("Edit device"));
vi.mock("@/app/components/firmware/FirmwareUploadDialog", () => stub("Upload firmware"));

import type { Device } from "@/lib/devices";
import { axeViolations } from "@/app/components/ui/testing/axe";
import DevicesPage from "@/app/(app)/devices/page";

const PUMP = "11111111-1111-4111-8111-111111111111";
const MONITOR = "22222222-2222-4222-8222-222222222222";
const WATCH = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "0192b000-0000-7000-8000-000000000001";

function devices(): Device[] {
  return [
    {
      deviceId: PUMP, name: "Infusion Pump", type: "Infusion pump", role: "owner", reverseEngineeringStatus: "complete",
      manufacturer: "Baxter", modelNumber: "SIGMA-1", description: "Large-volume pump", profileImageArtifactId: IMAGE_ID,
      updatedAt: "2026-10-05T12:00:00Z",
    },
    {
      deviceId: MONITOR, name: "ICU Monitor", type: "Patient monitor", role: "owner", reverseEngineeringStatus: "in_progress",
      manufacturer: "Philips", modelNumber: "MX800",
    },
    { deviceId: WATCH, name: "HR Watch", type: "Wearable", role: "owner", reverseEngineeringStatus: "not_started" },
  ];
}

function artifactsPage(count: number, more = false) {
  return {
    artifacts: Array.from({ length: count }, (_, i) => ({ artifactId: `a${i}`, type: "binary" })),
    ...(more ? { nextToken: "next" } : {}),
  };
}

beforeEach(() => {
  workspace.state = {
    scope: { kind: "personal" },
    scopeReady: true,
    reportWorkspaceUnavailable: vi.fn(),
  };
  dialogs.props = {};
  window.localStorage.clear();
  api.getDevices.mockResolvedValue(devices());
  api.listCves.mockResolvedValue([
    { cveRecordId: "c1", deviceIds: [PUMP, MONITOR] },
    { cveRecordId: "c2", deviceIds: [PUMP] },
  ]);
  api.listDeviceArtifacts.mockImplementation(async (deviceId: string) =>
    deviceId === PUMP ? artifactsPage(100, true) : deviceId === MONITOR ? artifactsPage(3) : artifactsPage(0)
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderLoaded() {
  const view = render(<DevicesPage />);
  await screen.findByRole("table", { name: "Devices" });
  // Artifact counts arrive after the list.
  await waitFor(() => expect(api.listDeviceArtifacts).toHaveBeenCalledTimes(3));
  await screen.findByTitle("Artifacts: at least 100");
  return view;
}

const rowNames = () =>
  within(screen.getByRole("table", { name: "Devices" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("aria-label"));

function summaryCard(label: string) {
  return within(screen.getByRole("group", { name: "Devices by reverse-engineering status" })).getByRole("button", {
    name: new RegExp(label),
  });
}

describe("Devices page", () => {
  it("summarises the scope's devices by reverse-engineering status", async () => {
    await renderLoaded();
    expect(summaryCard("Total devices").textContent).toContain("3");
    expect(summaryCard("RE completed").textContent).toContain("1");
    expect(summaryCard("RE in progress").textContent).toContain("1");
    expect(summaryCard("RE not started").textContent).toContain("1");
  });

  it("lists devices by name with their real CVE and artifact counts", async () => {
    await renderLoaded();
    expect(rowNames()).toEqual(["Open HR Watch", "Open ICU Monitor", "Open Infusion Pump"]);
    const pump = screen.getByRole("row", { name: "Open Infusion Pump" });
    expect(within(pump).getByText("Baxter")).toBeTruthy();
    expect(within(pump).getByText("SIGMA-1")).toBeTruthy();
    expect(within(pump).getByTitle("Linked CVEs: 2")).toBeTruthy();
    expect(within(pump).getByTitle("Artifacts: at least 100")).toBeTruthy();
    expect(within(pump).getByText("Owner")).toBeTruthy();
    expect(within(pump).getByRole("img", { name: "Profile picture of Infusion Pump" }).getAttribute("src")).toBe(
      "https://images.example/pump.png"
    );
    const watch = screen.getByRole("row", { name: "Open HR Watch" });
    expect(within(watch).getByTitle("Linked CVEs: 0")).toBeTruthy();
    expect(within(watch).getByTitle("Artifacts: 0")).toBeTruthy();
    // No picture: the fallback illustration, named as such.
    expect(within(watch).getByRole("img", { name: "Profile picture of HR Watch (no picture)" })).toBeTruthy();
    // A device without an update time shows a dash, not a made-up date.
    expect(within(watch).getAllByText("—").length).toBeGreaterThan(0);
    expect(api.listDeviceArtifacts).toHaveBeenCalledWith(PUMP, { limit: 100 });
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("opens a device from its row", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("row", { name: "Open ICU Monitor" }));
    expect(nav.push).toHaveBeenCalledWith(`/devices/view?id=${MONITOR}`);
  });

  it("sorts by a column header", async () => {
    await renderLoaded();
    const header = screen.getByRole("columnheader", { name: /CVEs/ });
    fireEvent.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(rowNames()).toEqual(["Open HR Watch", "Open ICU Monitor", "Open Infusion Pump"]);
    fireEvent.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(rowNames()).toEqual(["Open Infusion Pump", "Open ICU Monitor", "Open HR Watch"]);
  });

  it("searches by manufacturer and model, and filters by status and manufacturer", async () => {
    await renderLoaded();
    const search = screen.getByRole("searchbox", { name: /Search devices/ });
    fireEvent.change(search, { target: { value: "mx800" } });
    expect(rowNames()).toEqual(["Open ICU Monitor"]);
    fireEvent.change(search, { target: { value: "baxter" } });
    expect(rowNames()).toEqual(["Open Infusion Pump"]);
    expect(screen.getByText("Showing 1 of 3 devices")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(rowNames()).toHaveLength(3);

    fireEvent.change(screen.getByRole("combobox", { name: "Filter by reverse-engineering status" }), {
      target: { value: "not_started" },
    });
    expect(rowNames()).toEqual(["Open HR Watch"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by reverse-engineering status" }), { target: { value: "" } });

    const manufacturer = screen.getByRole("combobox", { name: "Filter by manufacturer" });
    expect(within(manufacturer).getAllByRole("option").map((o) => o.textContent)).toEqual(["All manufacturers", "Baxter", "Philips"]);
    fireEvent.change(manufacturer, { target: { value: "Philips" } });
    expect(rowNames()).toEqual(["Open ICU Monitor"]);
  });

  it("filters by status from the summary cards", async () => {
    await renderLoaded();
    fireEvent.click(summaryCard("RE in progress"));
    expect(summaryCard("RE in progress").getAttribute("aria-pressed")).toBe("true");
    expect(rowNames()).toEqual(["Open ICU Monitor"]);
    fireEvent.click(summaryCard("RE in progress"));
    expect(rowNames()).toHaveLength(3);
  });

  it("switches to the grid without reloading, keeping the filters, and remembers the choice", async () => {
    const { unmount } = await renderLoaded();
    fireEvent.change(screen.getByRole("searchbox", { name: /Search devices/ }), { target: { value: "i" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by reverse-engineering status" }), {
      target: { value: "complete" },
    });

    expect(screen.getByRole("button", { name: "List view" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.getByRole("button", { name: "Grid view" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("table")).toBeNull();

    const grid = screen.getByRole("list", { name: "Devices" });
    expect(within(grid).getAllByRole("listitem")).toHaveLength(1);
    expect((screen.getByRole("searchbox", { name: /Search devices/ }) as HTMLInputElement).value).toBe("i");

    // Same data: nothing was requested again.
    expect(api.getDevices).toHaveBeenCalledTimes(1);
    expect(api.listCves).toHaveBeenCalledTimes(1);
    expect(api.listDeviceArtifacts).toHaveBeenCalledTimes(3);

    unmount();
    render(<DevicesPage />);
    await screen.findByRole("list", { name: "Devices" });
    expect(screen.getByRole("button", { name: "Grid view" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows each device as a card with its image, details, figures and a link to its page", async () => {
    window.localStorage.setItem("vzoniq.devices.v1.user-1", JSON.stringify({ view: "grid" }));
    const { container } = render(<DevicesPage />);
    await screen.findByRole("list", { name: "Devices" });
    await waitFor(() => expect(screen.getAllByTitle("Artifacts: at least 100")).toHaveLength(1));

    const card = screen.getByRole("link", { name: "Infusion Pump" }).closest("article")!;
    expect(screen.getByRole("link", { name: "Infusion Pump" }).getAttribute("href")).toBe(`/devices/view?id=${PUMP}`);
    expect(within(card).getByRole("img", { name: "Profile picture of Infusion Pump" })).toBeTruthy();
    expect(within(card).getByText("Complete")).toBeTruthy();
    expect(within(card).getByText("Baxter")).toBeTruthy();
    expect(within(card).getByText("SIGMA-1")).toBeTruthy();
    expect(within(card).getByText("Infusion pump")).toBeTruthy();
    expect(within(card).getByTitle("CVEs: 2")).toBeTruthy();
    expect(within(card).getByText(/Updated/)).toBeTruthy();

    const watch = screen.getByRole("link", { name: "HR Watch" }).closest("article")!;
    expect(within(watch).getByRole("img", { name: "Profile picture of HR Watch (no picture)" })).toBeTruthy();
    expect(within(watch).getByText("Owner access")).toBeTruthy();

    // The sort menu replaces column headers in the grid.
    fireEvent.change(screen.getByRole("combobox", { name: "Sort devices" }), { target: { value: "cves:desc" } });
    expect(screen.getAllByRole("link", { name: /Pump|Monitor|Watch/ }).map((a) => a.textContent)).toEqual([
      "Infusion Pump",
      "ICU Monitor",
      "HR Watch",
    ]);

    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers the device actions from each card's menu", async () => {
    window.localStorage.setItem("vzoniq.devices.v1.user-1", JSON.stringify({ view: "grid" }));
    render(<DevicesPage />);
    await screen.findByRole("list", { name: "Devices" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for ICU Monitor" }));
    const menu = screen.getByRole("menu", { name: "Actions for ICU Monitor" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "View details",
      "Edit details",
      "View firmware",
      "View images",
      "View CVEs",
      "Open RE Notebook",
      "Upload firmware",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Edit details" }));
    expect(screen.getByRole("dialog", { name: "Edit device" })).toBeTruthy();
    act(() => (dialogs.props["Edit device"].onSaved as (d: Device) => void)({ ...devices()[1], name: "ICU Monitor v2" }));
    expect(screen.getByRole("link", { name: "ICU Monitor v2" })).toBeTruthy();
  });

  it("updates the reverse-engineering status from the list", async () => {
    api.updateDeviceReverseEngineeringStatus.mockResolvedValue({
      deviceId: WATCH, name: "HR Watch", reverseEngineeringStatus: "in_progress", updatedAt: "2026-11-01T00:00:00Z",
    });
    await renderLoaded();
    fireEvent.change(screen.getByRole("combobox", { name: "Reverse-engineering status for HR Watch" }), {
      target: { value: "in_progress" },
    });
    await waitFor(() => expect(summaryCard("RE in progress").textContent).toContain("2"));
    expect(api.updateDeviceReverseEngineeringStatus).toHaveBeenCalledWith(WATCH, "in_progress");
    expect((screen.getByRole("combobox", { name: "Reverse-engineering status for HR Watch" }) as HTMLSelectElement).value).toBe(
      "in_progress"
    );
  });

  it("keeps the saved status and explains when the update fails", async () => {
    api.updateDeviceReverseEngineeringStatus.mockRejectedValue(new Error("Not authorized for this device"));
    await renderLoaded();
    fireEvent.change(screen.getByRole("combobox", { name: "Reverse-engineering status for HR Watch" }), {
      target: { value: "complete" },
    });
    expect(await screen.findByText("Couldn't update HR Watch: Not authorized for this device")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Reverse-engineering status for HR Watch" }) as HTMLSelectElement).value).toBe(
      "not_started"
    );
  });

  it("shows a dash rather than zero when CVE counts can't be loaded", async () => {
    api.listCves.mockRejectedValue(new Error("boom"));
    render(<DevicesPage />);
    await screen.findByRole("table", { name: "Devices" });
    expect(await screen.findByText(/CVE counts couldn.t be loaded/)).toBeTruthy();
    const pump = screen.getByRole("row", { name: "Open Infusion Pump" });
    expect(within(pump).getByText("Linked CVEs: not available")).toBeTruthy();
  });

  it("reads the active workspace's devices and CVEs only", async () => {
    workspace.state = { ...workspace.state, scope: { kind: "workspace", workspaceId: WORKSPACE_ID, name: "Lab" } };
    await renderLoaded();
    expect(api.getDevices).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(api.listCves).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(screen.getByText("Lab")).toBeTruthy();
  });

  it("has an empty state for a scope without devices", async () => {
    api.getDevices.mockResolvedValue([]);
    render(<DevicesPage />);
    expect(await screen.findByRole("heading", { name: "No devices yet" })).toBeTruthy();
    expect(api.listDeviceArtifacts).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Add device" })[1]);
    expect(screen.getByRole("dialog", { name: "Add device" })).toBeTruthy();
  });

  it("has an empty state when nothing matches, in either view", async () => {
    await renderLoaded();
    fireEvent.change(screen.getByRole("searchbox", { name: /Search devices/ }), { target: { value: "zzz" } });
    expect(screen.getByRole("heading", { name: "No devices match these filters" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.getByRole("heading", { name: "No devices match these filters" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" }).at(-1)!);
    expect(within(screen.getByRole("list", { name: "Devices" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("shows an error with a retry when devices can't be loaded", async () => {
    api.getDevices.mockRejectedValueOnce(new Error("Network down"));
    render(<DevicesPage />);
    expect(await screen.findByText("Network down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Devices" })).toBeTruthy();
    expect(api.getDevices).toHaveBeenCalledTimes(2);
  });

  it("refreshes devices and their counts", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.getDevices).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.listDeviceArtifacts).toHaveBeenCalledTimes(6));
    expect(api.listCves).toHaveBeenCalledTimes(2);
  });
});
