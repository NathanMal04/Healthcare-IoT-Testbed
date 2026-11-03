// @vitest-environment jsdom
// Regression tests for the Device Details page (/devices/view): routing and
// deep links, loading and scope checks, and how each section is wired to the
// API and to the shared components. The child components (gallery, profile
// picture, CVE list/details/explorer, uploaders, dialogs) have their own tests;
// here they are stubs that record their props, so these tests pin down the
// page's own behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// --- Navigation ------------------------------------------------------------------

const nav = vi.hoisted(() => ({ search: "", push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/devices/view",
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// --- Workspace ---------------------------------------------------------------------

const workspace = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  locks: [] as boolean[],
}));
vi.mock("@/context/WorkspaceContext", () => ({
  useWorkspace: () => workspace.state,
  useScopeLock: (active: boolean) => {
    workspace.locks.push(active);
  },
}));

const crumbs = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/app/components/shell/ShellContext", () => ({
  usePageCrumbs: (value: unknown) => {
    crumbs.calls.push(value);
  },
}));

// --- API ---------------------------------------------------------------------------

const api = vi.hoisted(() => ({
  getDevice: vi.fn(),
  getDevices: vi.fn(),
  updateDeviceReverseEngineeringStatus: vi.fn(),
  setDeviceProfileImage: vi.fn(),
  listDeviceArtifacts: vi.fn(),
  getArtifactDownloadUrl: vi.fn(),
  listCves: vi.fn(),
  unlinkCveDevice: vi.fn(),
  loadDeviceFirmware: vi.fn(),
}));
vi.mock("@/lib/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/devices")>()),
  getDevice: api.getDevice,
  getDevices: api.getDevices,
  updateDeviceReverseEngineeringStatus: api.updateDeviceReverseEngineeringStatus,
  setDeviceProfileImage: api.setDeviceProfileImage,
}));
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  listDeviceArtifacts: api.listDeviceArtifacts,
  getArtifactDownloadUrl: api.getArtifactDownloadUrl,
}));
vi.mock("@/lib/cves", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cves")>()),
  listCves: api.listCves,
  unlinkCveDevice: api.unlinkCveDevice,
}));

// --- Child components (stubs that record their props) -----------------------------

const stubs = vi.hoisted(() => ({
  props: {} as Record<string, Record<string, unknown>>,
  mounts: {} as Record<string, number>,
  imageUrls: { refresh: vi.fn() },
}));

vi.mock("@/app/components/firmware/FirmwareList", async (importOriginal) => {
  const { useEffect } = await import("react");
  return {
    ...(await importOriginal<typeof import("@/app/components/firmware/FirmwareList")>()),
    loadDeviceFirmware: api.loadDeviceFirmware,
    FirmwareTable: (props: { firmware: { artifactId: string; name: string }[]; onRetry: (f: unknown) => void }) => {
      stubs.props.FirmwareTable = props;
      return (
        <ul aria-label="Firmware table">
          {props.firmware.map((f) => (
            <li key={f.artifactId}>
              {f.name}
              <button type="button" onClick={() => props.onRetry(f)}>
                Retry {f.name}
              </button>
            </li>
          ))}
        </ul>
      );
    },
    FirmwareRetryDialog: (props: Record<string, unknown>) => {
      stubs.props.FirmwareRetryDialog = props;
      useEffect(() => undefined, []);
      return <div role="dialog" aria-label="Retry firmware" />;
    },
  };
});

function recordingStub(name: string, render: (props: Record<string, unknown>) => React.ReactNode = () => null) {
  return async () => {
    const { useEffect } = await import("react");
    return {
      default: function Stub(props: Record<string, unknown>) {
        stubs.props[name] = props;
        useEffect(() => {
          stubs.mounts[name] = (stubs.mounts[name] ?? 0) + 1;
        }, []);
        return <>{render(props)}</>;
      },
    };
  };
}

vi.mock(
  "@/app/components/firmware/FirmwareUploadDialog",
  recordingStub("FirmwareUploadDialog", () => <div role="dialog" aria-label="Upload firmware dialog" />)
);
vi.mock(
  "@/app/components/EditDeviceDialog",
  recordingStub("EditDeviceDialog", () => <div role="dialog" aria-label="Edit device dialog" />)
);
vi.mock(
  "@/app/components/ArtifactUploader",
  recordingStub("ArtifactUploader", (p) => <div data-testid="artifact-uploader">{String(p.fixedType ?? "all")}</div>)
);
vi.mock(
  "@/app/components/CveDetails",
  recordingStub("CveDetails", (p) => {
    const Frame = p.Frame as React.ComponentType<{ cveId?: string; children: React.ReactNode }>;
    return (
      <Frame cveId="CVE-2024-0001">
        <div data-testid="cve-details">{String(p.cveRecordId)}</div>
        {p.backAction as React.ReactNode}
      </Frame>
    );
  })
);
vi.mock(
  "@/app/components/CveList",
  recordingStub("CveList", (p) => {
    const cves = p.cves as { cveRecordId: string; cveId: string }[] | null;
    if (p.error) return <p>{String(p.error)}</p>;
    if (cves === null) return <p>Loading CVEs…</p>;
    if (cves.length === 0) return p.empty as React.ReactNode;
    const actions = p.actions as (c: unknown) => React.ReactNode;
    const openHref = p.openHref as (c: unknown) => string;
    return (
      <ul aria-label="Linked CVE list">
        {cves.map((c) => (
          <li key={c.cveRecordId}>
            <a href={openHref(c)}>{c.cveId}</a>
            {actions(c)}
          </li>
        ))}
      </ul>
    );
  })
);
vi.mock(
  "@/app/components/CveLinkExplorer",
  recordingStub("CveLinkExplorer", () => <div role="dialog" aria-label="Link CVEs dialog" />)
);
vi.mock(
  "@/app/components/images/DeviceImageGallery",
  recordingStub("DeviceImageGallery", () => <div data-testid="image-gallery" />)
);
vi.mock(
  "@/app/components/images/DeviceProfilePicture",
  recordingStub("DeviceProfilePicture", () => <div data-testid="profile-picture" />)
);
vi.mock("@/app/components/images/useImageData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/components/images/useImageData")>()),
  useImageUrls: () => stubs.imageUrls,
}));

import DeviceViewPage from "@/app/(app)/devices/view/page";
import { ApiError } from "@/lib/api";
import type { Device } from "@/lib/devices";
import type { Artifact } from "@/lib/artifacts";
import type { Cve, CveSummary } from "@/lib/cves";

// --- Fixtures ----------------------------------------------------------------------

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const WS = { kind: "workspace", workspaceId: "ws-1", name: "Cardiac Lab", role: "member" };

function device(patch: Partial<Device> = {}): Device {
  return {
    deviceId: DEVICE_ID,
    name: "Infusion Pump X",
    type: "Infusion pump",
    role: "owner",
    reverseEngineeringStatus: "in_progress",
    manufacturer: "Philips",
    modelNumber: "MX800",
    profileImageArtifactId: "img-profile",
    ...patch,
  };
}

function artifact(id: string, patch: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: id,
    name: `${id}.bin`,
    type: "binary",
    origin: null,
    version: null,
    status: "ready",
    statusReason: null,
    sizeBytes: 1024,
    sha256: "x",
    originalFilename: `${id}.bin`,
    tags: [],
    deviceIds: [DEVICE_ID],
    uploadBatchId: null,
    uploadMode: "single",
    attemptId: "a1",
    createdAt: "2026-01-01T00:00:00Z",
    uploadedAt: "2026-01-01T00:00:00Z",
    statusUpdatedAt: null,
    ...patch,
  };
}

function cve(id: string, deviceIds: string[]): CveSummary {
  return {
    cveRecordId: `rec-${id}`,
    cveId: `CVE-2024-${id}`,
    severity: "high",
    cvssScore: 7.5,
    cvssVersion: "3.1",
    description: null,
    affectedChipsets: [],
    deviceIds,
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    version: 1,
  };
}

const FIRMWARE = [artifact("fw-1", { type: "firmware", name: "pump-2.4.bin" }), artifact("fw-2", { type: "firmware", name: "pump-2.5.bin" })];
const CVES = [cve("0001", [DEVICE_ID]), cve("0002", [DEVICE_ID, "other"]), cve("0003", ["other"])];

function setScope(scope: Record<string, unknown> = { kind: "personal" }, patch: Record<string, unknown> = {}) {
  workspace.state = {
    scope,
    scopeReady: true,
    scopeLocked: false,
    reportWorkspaceUnavailable: vi.fn(),
    ...patch,
  };
}

beforeEach(() => {
  nav.search = `id=${DEVICE_ID}`;
  nav.push.mockReset();
  nav.replace.mockReset();
  workspace.locks = [];
  crumbs.calls = [];
  stubs.props = {};
  stubs.mounts = {};
  stubs.imageUrls = { refresh: vi.fn() };
  setScope();
  for (const fn of Object.values(api)) fn.mockReset();
  api.getDevice.mockResolvedValue(device());
  api.getDevices.mockResolvedValue([device(), device({ deviceId: "other", name: "Other" })]);
  api.listCves.mockResolvedValue(CVES);
  api.loadDeviceFirmware.mockResolvedValue(FIRMWARE);
  api.listDeviceArtifacts.mockResolvedValue({ artifacts: [artifact("a-1"), artifact("a-2")] });
});
afterEach(cleanup);

async function renderPage(search = `id=${DEVICE_ID}`) {
  nav.search = search;
  const view = render(<DeviceViewPage />);
  await screen.findByRole("heading", { name: "Infusion Pump X" });
  return view;
}

const tab = (name: RegExp | string) => screen.getByRole("tab", { name });

// --- Routing and deep links -------------------------------------------------------

describe("Device page routing", () => {
  it("asks for a device when the link has no id", () => {
    nav.search = "";
    render(<DeviceViewPage />);
    expect(screen.getByText("No device selected")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Devices" }).getAttribute("href")).toBe("/devices");
    expect(api.getDevice).not.toHaveBeenCalled();
  });

  it("waits for the workspace before requesting anything", () => {
    setScope({ kind: "personal" }, { scopeReady: false });
    render(<DeviceViewPage />);
    expect(screen.getByText("Loading workspace…")).toBeTruthy();
    expect(api.getDevice).not.toHaveBeenCalled();
  });

  it("sends older RE Notebook links to the notebook workspace, keeping the entry", () => {
    nav.search = `id=${DEVICE_ID}&tab=notebook&entry=e-9`;
    render(<DeviceViewPage />);
    expect(screen.getByText("Opening the RE Notebook…")).toBeTruthy();
    expect(nav.replace).toHaveBeenCalledWith(`/devices/notebook?id=${DEVICE_ID}&entry=e-9`);
    expect(api.getDevice).not.toHaveBeenCalled();
  });

  it.each([
    ["", "Overview"],
    ["&tab=overview", "Overview"],
    ["&tab=firmware", "Firmware"],
    ["&tab=artifacts", "Artifacts"],
    ["&tab=images", "Images"],
    ["&tab=cves", "CVEs"],
    ["&tab=unknown", "Overview"],
    ["&cve=rec-0001", "CVEs"],
    ["&tab=firmware&cve=rec-0001", "CVEs"],
  ])("opens the section a link names (%s → %s)", async (extra, section) => {
    await renderPage(`id=${DEVICE_ID}${extra}`);
    expect(screen.getByRole("tab", { selected: true }).textContent).toMatch(new RegExp(`^${section}`));
  });

  it("switches sections in place, replacing the URL without scrolling; the notebook opens its own page", async () => {
    await renderPage();
    fireEvent.click(tab(/^Firmware/));
    expect(nav.replace).toHaveBeenLastCalledWith(`/devices/view?id=${DEVICE_ID}&tab=firmware`, { scroll: false });
    expect(screen.getByRole("tab", { selected: true }).textContent).toMatch(/^Firmware/);
    fireEvent.click(tab(/^CVEs/));
    expect(nav.replace).toHaveBeenLastCalledWith(`/devices/view?id=${DEVICE_ID}&tab=cves`, { scroll: false });
    fireEvent.click(tab("Overview"));
    expect(nav.replace).toHaveBeenLastCalledWith(`/devices/view?id=${DEVICE_ID}`, { scroll: false });
    expect(nav.push).not.toHaveBeenCalled();

    fireEvent.click(tab("RE Notebook"));
    expect(nav.push).toHaveBeenCalledWith(`/devices/notebook?id=${DEVICE_ID}`);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Overview");
  });
});

// --- Loading and scope ------------------------------------------------------------

describe("Device page loading", () => {
  it("loads the device, the scope's CVEs and devices, firmware and the overview's artifact page, once each", async () => {
    setScope(WS);
    api.getDevice.mockResolvedValue(device({ workspaceId: "ws-1", role: "member" }));
    await renderPage();
    await waitFor(() => expect(api.loadDeviceFirmware).toHaveBeenCalledTimes(1));
    expect(api.getDevice).toHaveBeenCalledTimes(1);
    expect(api.getDevice).toHaveBeenCalledWith(DEVICE_ID);
    expect(api.listCves).toHaveBeenCalledTimes(1);
    expect(api.listCves).toHaveBeenCalledWith("ws-1");
    expect(api.getDevices).toHaveBeenCalledTimes(1);
    expect(api.getDevices).toHaveBeenCalledWith("ws-1");
    expect(api.loadDeviceFirmware).toHaveBeenCalledWith(DEVICE_ID);
    expect(api.listDeviceArtifacts).toHaveBeenCalledTimes(1);
    expect(api.listDeviceArtifacts).toHaveBeenCalledWith(DEVICE_ID, { limit: 100 });
    expect(api.setDeviceProfileImage).not.toHaveBeenCalled();
  });

  it("shows the device's header, access, counts, and names it in the breadcrumb", async () => {
    await renderPage();
    expect(screen.getByText("Device · Infusion pump")).toBeTruthy();
    expect(screen.getByText("Your access: owner")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Devices/ }).getAttribute("href")).toBe("/devices");
    expect(screen.getByTestId("profile-picture")).toBeTruthy();
    expect(stubs.props.DeviceProfilePicture.canEdit).toBe(true);
    await waitFor(() => expect(tab(/^Firmware/).textContent).toBe("Firmware2"));
    expect(tab(/^CVEs/).textContent).toBe("CVEs2");
    expect(crumbs.calls.at(-1)).toEqual([{ label: "Devices", href: "/devices" }, { label: "Infusion Pump X" }]);
  });

  it("treats a device of another scope as not found, and loads no firmware for it", async () => {
    api.getDevice.mockResolvedValue(device({ workspaceId: "ws-other" }));
    render(<DeviceViewPage />);
    expect(await screen.findByRole("heading", { name: "Device not found" })).toBeTruthy();
    expect(screen.getByText("This device isn't available in Personal.")).toBeTruthy();
    expect(api.loadDeviceFirmware).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404])("treats a %i from the API as not found", async (status) => {
    setScope(WS);
    api.getDevice.mockRejectedValue(new ApiError("nope", status));
    render(<DeviceViewPage />);
    expect(await screen.findByText("This device isn't available in Cardiac Lab.")).toBeTruthy();
  });

  it("shows other load failures as an error", async () => {
    api.getDevice.mockRejectedValue(new ApiError("Server exploded", 500));
    render(<DeviceViewPage />);
    expect(await screen.findByText("Couldn't load the device")).toBeTruthy();
    expect(screen.getByText("Server exploded")).toBeTruthy();
  });

  it("reports a workspace that has gone when its CVE list is refused", async () => {
    setScope(WS);
    api.getDevice.mockResolvedValue(device({ workspaceId: "ws-1" }));
    api.listCves.mockRejectedValue(new ApiError("gone", 404));
    await renderPage();
    await waitFor(() => expect(workspace.state.reportWorkspaceUnavailable).toHaveBeenCalled());
  });

  it("does not report Personal as gone when its CVE list fails", async () => {
    api.listCves.mockRejectedValue(new ApiError("gone", 404));
    await renderPage();
    await waitFor(() => expect(api.listCves).toHaveBeenCalled());
    expect(workspace.state.reportWorkspaceUnavailable).not.toHaveBeenCalled();
  });

  it("keeps the latest CVE load when an older one finishes after it", async () => {
    let finishFirst!: (cves: CveSummary[]) => void;
    api.listCves.mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)));
    await renderPage(`id=${DEVICE_ID}&tab=cves`);
    await waitFor(() => expect(stubs.props.CveList).toBeTruthy());
    api.listCves.mockResolvedValueOnce([cve("0001", [DEVICE_ID])]);
    await act(async () => (stubs.props.CveList.onRefresh as () => void)());
    expect(tab(/^CVEs/).textContent).toBe("CVEs1");
    await act(async () => finishFirst(CVES));
    expect(tab(/^CVEs/).textContent).toBe("CVEs1");
  });

  it("reloads the firmware whenever the device record changes", async () => {
    api.updateDeviceReverseEngineeringStatus.mockResolvedValue({ reverseEngineeringStatus: "complete" });
    await renderPage();
    await waitFor(() => expect(api.loadDeviceFirmware).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Reverse-engineering status for Infusion Pump X"), {
      target: { value: "complete" },
    });
    await waitFor(() => expect(api.loadDeviceFirmware).toHaveBeenCalledTimes(2));
  });

  it("reloads everything when the scope changes", async () => {
    const view = await renderPage();
    await waitFor(() => expect(api.loadDeviceFirmware).toHaveBeenCalledTimes(1));
    setScope(WS);
    api.getDevice.mockResolvedValue(device({ workspaceId: "ws-1", name: "Infusion Pump X" }));
    view.rerender(<DeviceViewPage />);
    await waitFor(() => expect(api.getDevice).toHaveBeenCalledTimes(2));
    expect(api.listCves).toHaveBeenLastCalledWith("ws-1");
    await waitFor(() => expect(api.loadDeviceFirmware).toHaveBeenCalledTimes(2));
  });
});

// --- Overview ---------------------------------------------------------------------

describe("Device overview", () => {
  it("lists the device's details, scope and access", async () => {
    await renderPage();
    expect(screen.getByText("Device information")).toBeTruthy();
    expect(document.querySelectorAll("dl")).toHaveLength(1);
    const rows = Array.from(document.querySelectorAll("dl dt")).map(
      (dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`
    );
    expect(rows).toEqual([
      "Name: Infusion Pump X",
      "Type: Infusion pump",
      "Manufacturer: Philips",
      "Model number: MX800",
      "Scope: Personal",
      "Your access: owner",
    ]);
  });

  it("changes only the status, keeping a profile picture chosen while it saved", async () => {
    let finishStatus!: () => void;
    api.updateDeviceReverseEngineeringStatus.mockReturnValue(
      new Promise((resolve) => (finishStatus = () => resolve({ reverseEngineeringStatus: "complete", name: "Stale" })))
    );
    api.setDeviceProfileImage.mockResolvedValue({
      deviceId: DEVICE_ID,
      name: "Infusion Pump X",
      reverseEngineeringStatus: "in_progress",
      updatedAt: null,
      profileImageArtifactId: "img-2",
    });
    await renderPage();
    fireEvent.change(screen.getByLabelText("Reverse-engineering status for Infusion Pump X"), {
      target: { value: "complete" },
    });
    await act(async () => {
      await (stubs.props.DeviceProfilePicture.profile as { setProfile: (id: string, n: string) => Promise<boolean> }).setProfile(
        "img-2",
        "Changed."
      );
    });
    await act(async () => finishStatus());
    expect((stubs.props.DeviceProfilePicture.device as Device).profileImageArtifactId).toBe("img-2");
    expect((stubs.props.DeviceProfilePicture.device as Device).reverseEngineeringStatus).toBe("complete");
    expect(screen.getByRole("heading", { name: "Infusion Pump X" })).toBeTruthy();
  });

  it("shows the counts and opens their sections", async () => {
    api.listDeviceArtifacts.mockResolvedValue({ artifacts: [artifact("a-1")], nextToken: "more" });
    await renderPage();
    const tile = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });
    await waitFor(() => expect(tile("Firmware versions").textContent).toContain("2"));
    await waitFor(() => expect(tile("Artifacts").textContent).toContain("1+"));
    expect(tile("Linked CVEs").textContent).toContain("2");
    fireEvent.click(tile("Artifacts"));
    expect(nav.replace).toHaveBeenLastCalledWith(`/devices/view?id=${DEVICE_ID}&tab=artifacts`, { scroll: false });
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Artifacts");
  });

  it("saves a new research status, keeping the saved one shown on failure", async () => {
    api.updateDeviceReverseEngineeringStatus.mockResolvedValueOnce({ reverseEngineeringStatus: "complete" });
    await renderPage();
    const select = screen.getByLabelText("Reverse-engineering status for Infusion Pump X") as HTMLSelectElement;
    expect(select.value).toBe("in_progress");
    fireEvent.change(select, { target: { value: "complete" } });
    expect(screen.getByText("Saving…")).toBeTruthy();
    await waitFor(() => expect(select.value).toBe("complete"));
    expect(api.updateDeviceReverseEngineeringStatus).toHaveBeenCalledWith(DEVICE_ID, "complete");

    api.updateDeviceReverseEngineeringStatus.mockRejectedValueOnce(new Error("No access"));
    fireEvent.change(select, { target: { value: "not_started" } });
    expect(await screen.findByText("Couldn't update Infusion Pump X: No access")).toBeTruthy();
    expect(select.value).toBe("complete");
  });
});

// --- Editing and the profile picture ----------------------------------------------

describe("Device editing and profile picture", () => {
  it("opens the edit dialog and shows the saved device", async () => {
    await renderPage();
    expect(screen.queryByRole("dialog", { name: "Edit device dialog" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Device" }));
    expect(screen.getByRole("dialog", { name: "Edit device dialog" })).toBeTruthy();
    expect((stubs.props.EditDeviceDialog.device as Device).name).toBe("Infusion Pump X");
    act(() => (stubs.props.EditDeviceDialog.onSaved as (d: Device) => void)(device({ name: "Renamed Pump" })));
    expect(screen.getByRole("heading", { name: "Renamed Pump" })).toBeTruthy();
    act(() => (stubs.props.EditDeviceDialog.onClose as () => void)());
    expect(screen.queryByRole("dialog", { name: "Edit device dialog" })).toBeNull();
  });

  it("shows the edit button and read-only picture to viewers", async () => {
    api.getDevice.mockResolvedValue(device({ role: "viewer" }));
    await renderPage();
    expect(screen.getByRole("button", { name: "Edit Device" })).toBeTruthy();
    expect(stubs.props.DeviceProfilePicture.canEdit).toBe(false);
  });

  it("refreshes the header and the gallery when the profile picture's file is replaced", async () => {
    await renderPage(`id=${DEVICE_ID}&tab=images`);
    expect(stubs.mounts.DeviceImageGallery).toBe(1);
    act(() => (stubs.props.DeviceProfilePicture.onFileReplaced as (i: unknown) => void)({ artifactId: "img-profile" }));
    expect(stubs.imageUrls.refresh).toHaveBeenCalledWith("img-profile");
    expect(stubs.props.DeviceProfilePicture.fileVersion).toBe(1);
    expect(stubs.mounts.DeviceImageGallery).toBe(2);
    act(() => (stubs.props.DeviceProfilePicture.onGalleryChanged as () => void)());
    expect(stubs.mounts.DeviceImageGallery).toBe(3);
  });

  it("sets a gallery image as the profile picture and announces it", async () => {
    api.setDeviceProfileImage.mockResolvedValue({
      deviceId: DEVICE_ID,
      name: "Infusion Pump X",
      reverseEngineeringStatus: "in_progress",
      updatedAt: null,
      profileImageArtifactId: "img-2",
      manufacturer: "Philips",
      modelNumber: "MX800",
    });
    await renderPage(`id=${DEVICE_ID}&tab=images`);
    const gallery = stubs.props.DeviceImageGallery;
    const badge = gallery.badge as (i: unknown) => string | null;
    expect(badge({ artifactId: "img-profile" })).toBe("Profile picture");
    expect(badge({ artifactId: "img-2" })).toBeNull();
    const extra = gallery.extraActions as (i: unknown) => unknown[];
    expect(extra({ artifactId: "img-profile", status: "ready", title: "Front" })).toEqual([false]);
    expect(extra({ artifactId: "img-3", status: "pending", title: "Back" })).toEqual([false]);
    const [action] = extra({ artifactId: "img-2", status: "ready", title: "Board" }) as { label: string; onSelect: () => void }[];
    expect(action.label).toBe("Set as profile picture");
    let finish!: () => void;
    const saved = api.setDeviceProfileImage.getMockImplementation()!;
    api.setDeviceProfileImage.mockImplementation((...args: unknown[]) =>
      new Promise((resolve) => (finish = () => resolve(saved(...args))))
    );
    workspace.locks = [];
    act(() => action.onSelect());
    expect(api.setDeviceProfileImage).toHaveBeenCalledWith(DEVICE_ID, "img-2");
    // The scope is held while the choice saves.
    expect(workspace.locks.at(-1)).toBe(true);
    await act(async () => finish());
    expect(await screen.findByText("Board is now the profile picture.")).toBeTruthy();
    expect(workspace.locks.at(-1)).toBe(false);
    expect((stubs.props.DeviceImageGallery.badge as (i: unknown) => string | null)({ artifactId: "img-2" })).toBe(
      "Profile picture"
    );
  });

  it("offers no profile actions in the gallery to viewers", async () => {
    api.getDevice.mockResolvedValue(device({ role: "viewer" }));
    await renderPage(`id=${DEVICE_ID}&tab=images`);
    const extra = stubs.props.DeviceImageGallery.extraActions as (i: unknown) => unknown[];
    expect(extra({ artifactId: "img-2", status: "ready", title: "Board" })).toEqual([false]);
  });

  it("refreshes the header picture only when the gallery replaces the profile image's file", async () => {
    await renderPage(`id=${DEVICE_ID}&tab=images`);
    const replaced = stubs.props.DeviceImageGallery.onImageReplaced as (i: unknown) => void;
    act(() => replaced({ artifactId: "img-other" }));
    expect(stubs.imageUrls.refresh).not.toHaveBeenCalled();
    act(() => replaced({ artifactId: "img-profile" }));
    expect(stubs.imageUrls.refresh).toHaveBeenCalledWith("img-profile");
    expect(stubs.props.DeviceProfilePicture.fileVersion).toBe(1);
  });
});

// --- Firmware ---------------------------------------------------------------------

describe("Device firmware", () => {
  it("lists firmware, uploads and retries, reloading after each", async () => {
    await renderPage(`id=${DEVICE_ID}&tab=firmware`);
    expect(await screen.findByText("pump-2.4.bin")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upload firmware" }));
    expect(screen.getByRole("dialog", { name: "Upload firmware dialog" })).toBeTruthy();
    expect((stubs.props.FirmwareUploadDialog.device as Device).deviceId).toBe(DEVICE_ID);
    api.loadDeviceFirmware.mockResolvedValue([...FIRMWARE, artifact("fw-3", { type: "firmware", name: "pump-2.6.bin" })]);
    await act(async () => (stubs.props.FirmwareUploadDialog.onUploaded as () => void)());
    expect(await screen.findByText("pump-2.6.bin")).toBeTruthy();
    expect(tab(/^Firmware/).textContent).toBe("Firmware3");
    act(() => (stubs.props.FirmwareUploadDialog.onClose as () => void)());
    expect(screen.queryByRole("dialog", { name: "Upload firmware dialog" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry pump-2.4.bin" }));
    expect(screen.getByRole("dialog", { name: "Retry firmware" })).toBeTruthy();
    await act(async () => (stubs.props.FirmwareRetryDialog.onRetried as () => void)());
    expect(api.loadDeviceFirmware).toHaveBeenCalledTimes(3);
  });

  it("offers an upload when there is no firmware, and shows load failures", async () => {
    api.loadDeviceFirmware.mockResolvedValueOnce([]);
    await renderPage(`id=${DEVICE_ID}&tab=firmware`);
    expect(await screen.findByText("No firmware uploaded yet")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Upload firmware" })).toHaveLength(2);
    cleanup();
    api.loadDeviceFirmware.mockRejectedValueOnce(new Error("Firmware down"));
    await renderPage(`id=${DEVICE_ID}&tab=firmware`);
    expect(await screen.findByText("Couldn't load firmware")).toBeTruthy();
    expect(screen.getByText("Firmware down")).toBeTruthy();
  });
});

// --- Artifacts --------------------------------------------------------------------

describe("Device artifacts", () => {
  it("lists every file, filters by type, and pages", async () => {
    api.listDeviceArtifacts.mockImplementation(async (_id: string, params: { type?: string; nextToken?: string }) => {
      if (params.type === "pcap") return { artifacts: [artifact("p-1", { type: "pcap", name: "capture.pcap" })] };
      if (params.nextToken) return { artifacts: [artifact("a-3", { name: "third.bin" })] };
      return { artifacts: [artifact("a-1", { name: "first.bin" })], nextToken: "t1" };
    });
    await renderPage(`id=${DEVICE_ID}&tab=artifacts`);
    expect(await screen.findByText("first.bin")).toBeTruthy();
    expect(api.listDeviceArtifacts).toHaveBeenLastCalledWith(DEVICE_ID, { limit: 100, type: undefined, nextToken: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("third.bin")).toBeTruthy();
    expect(screen.getByText("first.bin")).toBeTruthy();
    expect(api.listDeviceArtifacts).toHaveBeenLastCalledWith(DEVICE_ID, { limit: 100, type: undefined, nextToken: "t1" });

    fireEvent.click(screen.getByRole("button", { name: "PCAP" }));
    expect(await screen.findByText("capture.pcap")).toBeTruthy();
    expect(api.listDeviceArtifacts).toHaveBeenLastCalledWith(DEVICE_ID, { limit: 100, type: "pcap", nextToken: undefined });
    expect(screen.getByRole("button", { name: "Upload PCAP" })).toBeTruthy();
  });

  it("opens the uploader for the chosen type, closing it after a clean upload only", async () => {
    await renderPage(`id=${DEVICE_ID}&tab=artifacts`);
    await screen.findByText("a-1.bin");
    fireEvent.click(screen.getByRole("button", { name: "Upload new artifact" }));
    expect(screen.getByTestId("artifact-uploader").textContent).toBe("all");
    expect(stubs.props.ArtifactUploader.fixedDevice).toMatchObject({ deviceId: DEVICE_ID });
    const calls = api.listDeviceArtifacts.mock.calls.length;
    await act(async () => (stubs.props.ArtifactUploader.onFinished as (b: string, f: number) => void)("batch-1", 1));
    expect(api.listDeviceArtifacts.mock.calls.length).toBe(calls + 1);
    expect(screen.getByTestId("artifact-uploader")).toBeTruthy();
    await act(async () => (stubs.props.ArtifactUploader.onFinished as (b: string, f: number) => void)("batch-1", 0));
    expect(screen.queryByTestId("artifact-uploader")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Upload Log" }));
    expect(screen.getByTestId("artifact-uploader").textContent).toBe("log");
    fireEvent.click(screen.getByRole("button", { name: "Close uploader" }));
    expect(screen.queryByTestId("artifact-uploader")).toBeNull();
  });

  it("keeps the uploader and the type filter while an upload holds the scope", async () => {
    setScope({ kind: "personal" }, { scopeLocked: true });
    await renderPage(`id=${DEVICE_ID}&tab=artifacts`);
    await screen.findByText("a-1.bin");
    fireEvent.click(screen.getByRole("button", { name: "Upload new artifact" }));
    const close = screen.getByRole("button", { name: "Close uploader" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(close.title).toBe("Cancel the running upload first");
    expect((screen.getByRole("button", { name: "PCAP" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("downloads a ready file, reporting a failure", async () => {
    api.getArtifactDownloadUrl.mockRejectedValue(new Error("Link expired"));
    await renderPage(`id=${DEVICE_ID}&tab=artifacts`);
    await screen.findByText("a-1.bin");
    fireEvent.click(screen.getByRole("button", { name: "Actions for a-1.bin" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
    expect(await screen.findByText("Couldn't download: Link expired")).toBeTruthy();
    expect(api.getArtifactDownloadUrl).toHaveBeenCalledWith("a-1");
  });

  it("names an empty category, and shows load failures", async () => {
    api.listDeviceArtifacts.mockResolvedValue({ artifacts: [] });
    await renderPage(`id=${DEVICE_ID}&tab=artifacts`);
    expect(await screen.findByText("No files linked to this device yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Kernel Modules" }));
    expect(await screen.findByText("No Kernel Modules linked to this device")).toBeTruthy();
    api.listDeviceArtifacts.mockRejectedValue(new Error("Artifacts down"));
    fireEvent.click(screen.getByRole("button", { name: "Binary" }));
    expect(await screen.findByText("Couldn't load artifacts")).toBeTruthy();
  });
});

// --- CVEs -------------------------------------------------------------------------

describe("Device CVEs", () => {
  it("lists only this device's CVEs, linking each to its details on the device", async () => {
    await renderPage(`id=${DEVICE_ID}&tab=cves`);
    const list = await screen.findByRole("list", { name: "Linked CVE list" });
    expect(within(list).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["CVE-2024-0001", `/devices/view?id=${DEVICE_ID}&tab=cves&cve=rec-0001`],
      ["CVE-2024-0002", `/devices/view?id=${DEVICE_ID}&tab=cves&cve=rec-0002`],
    ]);
    expect(stubs.props.CveList.devices).toHaveLength(2);
    expect(screen.getByText("CVEs recorded in Personal that affect this device")).toBeTruthy();
    expect(screen.getByRole("link", { name: "All vulnerabilities" }).getAttribute("href")).toBe("/vulnerabilities");
  });

  it("refreshes the CVEs and device names", async () => {
    await renderPage(`id=${DEVICE_ID}&tab=cves`);
    await screen.findByRole("list", { name: "Linked CVE list" });
    api.listCves.mockResolvedValue([cve("0001", [DEVICE_ID])]);
    await act(async () => (stubs.props.CveList.onRefresh as () => void)());
    expect(api.listCves).toHaveBeenCalledTimes(2);
    expect(api.getDevices).toHaveBeenCalledTimes(2);
    expect(tab(/^CVEs/).textContent).toBe("CVEs1");
  });

  it("unlinks a CVE, holding the scope while it runs", async () => {
    let finish!: (value: { cve: Cve }) => void;
    api.unlinkCveDevice.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await renderPage(`id=${DEVICE_ID}&tab=cves`);
    await screen.findByRole("list", { name: "Linked CVE list" });
    workspace.locks = [];
    fireEvent.click(screen.getByRole("button", { name: "Actions for CVE-2024-0001" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unlink from device" }));
    expect(screen.getByText("Unlinking…")).toBeTruthy();
    expect(workspace.locks.at(-1)).toBe(true);
    expect(api.unlinkCveDevice).toHaveBeenCalledWith("rec-0001", DEVICE_ID);
    await act(async () => finish({ cve: { ...CVES[0], deviceIds: [], references: [] } }));
    expect(workspace.locks.at(-1)).toBe(false);
    const list = screen.getByRole("list", { name: "Linked CVE list" });
    expect(within(list).getAllByRole("link").map((a) => a.textContent)).toEqual(["CVE-2024-0002"]);
    expect(tab(/^CVEs/).textContent).toBe("CVEs1");
  });

  it("drops a CVE that has gone when unlinking it, and reports other failures", async () => {
    api.unlinkCveDevice.mockRejectedValueOnce(new ApiError("gone", 404));
    await renderPage(`id=${DEVICE_ID}&tab=cves`);
    await screen.findByRole("list", { name: "Linked CVE list" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for CVE-2024-0001" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unlink from device" }));
    expect(await screen.findByText("CVE-2024-0001 no longer exists, or you no longer have access to it.")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Linked CVE list" })).queryByText("CVE-2024-0001")).toBeNull();

    api.unlinkCveDevice.mockRejectedValueOnce(new ApiError("Server down", 500));
    fireEvent.click(screen.getByRole("button", { name: "Actions for CVE-2024-0002" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unlink from device" }));
    expect(await screen.findByText("Couldn't unlink the CVE. Please try again.")).toBeTruthy();
  });

  it("links CVEs through the explorer and announces how many", async () => {
    await renderPage(`id=${DEVICE_ID}&tab=cves`);
    await screen.findByRole("list", { name: "Linked CVE list" });
    fireEvent.click(screen.getByRole("button", { name: "Link CVEs" }));
    expect(screen.getByRole("dialog", { name: "Link CVEs dialog" })).toBeTruthy();
    expect(stubs.props.CveLinkExplorer.cves).toHaveLength(3);
    act(() =>
      (stubs.props.CveLinkExplorer.onLinked as (c: Cve[]) => void)([{ ...CVES[2], deviceIds: ["other", DEVICE_ID], references: [] }])
    );
    expect(tab(/^CVEs/).textContent).toBe("CVEs3");
    act(() => (stubs.props.CveLinkExplorer.onDone as (n: number) => void)(1));
    expect(screen.queryByRole("dialog", { name: "Link CVEs dialog" })).toBeNull();
    expect(screen.getByText("Linked 1 CVE to Infusion Pump X.")).toBeTruthy();
  });

  it("offers the explorer from the empty state", async () => {
    api.listCves.mockResolvedValue([cve("0003", ["other"])]);
    await renderPage(`id=${DEVICE_ID}&tab=cves`);
    expect(await screen.findByText("No CVEs linked to this device")).toBeTruthy();
    // The header's button and the empty state's.
    const buttons = screen.getAllByRole("button", { name: "Link CVEs" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(screen.getByRole("dialog", { name: "Link CVEs dialog" })).toBeTruthy();
  });

  it("opens a linked CVE's details inside the device, with the way back to its list", async () => {
    await renderPage(`id=${DEVICE_ID}&tab=cves&cve=rec-0001`);
    expect(screen.getByTestId("cve-details").textContent).toBe("rec-0001");
    expect(screen.queryByRole("list", { name: "Linked CVE list" })).toBeNull();
    const listHref = `/devices/view?id=${DEVICE_ID}&tab=cves`;
    expect(screen.getByRole("link", { name: "CVEs" }).getAttribute("href")).toBe(listHref);
    expect(screen.getAllByRole("link", { name: /Back to CVEs/ }).map((a) => a.getAttribute("href"))).toEqual([listHref, listHref]);
    expect(screen.getByRole("link", { name: /Open in Vulnerabilities/ }).getAttribute("href")).toBe(
      "/vulnerabilities/view?id=rec-0001"
    );
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();

    act(() =>
      (stubs.props.CveDetails.onChanged as (c: Cve) => void)({ ...CVES[0], deviceIds: [], references: [] })
    );
    expect(tab(/^CVEs/).textContent).toBe("CVEs1");
    act(() => (stubs.props.CveDetails.onDeleted as (id: string) => void)("rec-0002"));
    expect(nav.push).toHaveBeenCalledWith(listHref);
    expect(tab(/^CVEs/).textContent).toBe("CVEs0");
  });
});
