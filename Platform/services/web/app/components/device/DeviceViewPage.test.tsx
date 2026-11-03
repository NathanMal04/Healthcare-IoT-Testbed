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

// A small stand-in for the app router: the current query string, which
// push/replace (and the tests' own "browser" steps) change and the page
// re-renders from, as it does with the real useSearchParams.
const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    search: "",
    push: vi.fn(),
    replace: vi.fn(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Moves to another device page URL, as a link, Back or Forward would. */
    go(search: string) {
      state.search = search;
      listeners.forEach((l) => l());
    },
  };
  return state;
});
vi.mock("next/navigation", async () => {
  const { useMemo, useSyncExternalStore } = await import("react");
  return {
    usePathname: () => "/devices/view",
    useRouter: () => ({ push: nav.push, replace: nav.replace }),
    useSearchParams: () => {
      const search = useSyncExternalStore(nav.subscribe, () => nav.search);
      return useMemo(() => new URLSearchParams(search), [search]);
    },
  };
});
const auth = vi.hoisted(() => ({ userId: "user-1" }));
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { userId: auth.userId }, loading: false }),
}));

// --- Workspace ---------------------------------------------------------------------

const workspace = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  locks: [] as boolean[],
  /** Locks currently held, and how many have been released. */
  held: 0,
  released: 0,
}));
// useScopeLock records each value it's given, and reports a held lock to the
// nearest ScopeLockReporter, as the real context does.
vi.mock("@/context/WorkspaceContext", async () => {
  const React = await import("react");
  const Reporter = React.createContext<((delta: number) => void) | null>(null);
  return {
    useWorkspace: () => workspace.state,
    useScopeLock: (active: boolean) => {
      workspace.locks.push(active);
      const report = React.useContext(Reporter);
      React.useEffect(() => {
        if (!active) return;
        workspace.held++;
        report?.(1);
        return () => {
          workspace.held--;
          workspace.released++;
          report?.(-1);
        };
      }, [active, report]);
    },
    ScopeLockReporter: ({ onChange, children }: { onChange: (locked: boolean) => void; children: React.ReactNode }) => {
      const [held, setHeld] = React.useState(0);
      const report = React.useCallback((delta: number) => setHeld((n) => n + delta), []);
      React.useEffect(() => {
        onChange(held > 0);
      }, [held, onChange]);
      return React.createElement(Reporter.Provider, { value: report }, children);
    },
  };
});

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

/** A stand-in upload that holds the workspace while "running", like the real uploaders. */
function TestUpload({ name }: { name: string }) {
  const [running, setRunning] = useStateForStubs(false);
  useScopeLockForStubs(running);
  return (
    <button type="button" onClick={() => setRunning(!running)}>
      {running ? `Finish ${name}` : `Start ${name}`}
    </button>
  );
}
vi.mock(
  "@/app/components/firmware/FirmwareUploadDialog",
  recordingStub("FirmwareUploadDialog", () => (
    <div role="dialog" aria-label="Upload firmware dialog">
      <TestUpload name="firmware upload" />
    </div>
  ))
);
vi.mock(
  "@/app/components/EditDeviceDialog",
  recordingStub("EditDeviceDialog", () => <div role="dialog" aria-label="Edit device dialog" />)
);
vi.mock(
  "@/app/components/ArtifactUploader",
  recordingStub("ArtifactUploader", (p) => (
    <div data-testid="artifact-uploader">
      {String(p.fixedType ?? "all")}
      <TestUpload name="artifact upload" />
    </div>
  ))
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

import { useState as useStateForStubs } from "react";
import { useScopeLock as useScopeLockForStubs } from "@/context/WorkspaceContext";
import DeviceViewPage from "@/app/(app)/devices/view/page";
import { ApiError } from "@/lib/api";
import type { Device } from "@/lib/devices";
import type { Artifact } from "@/lib/artifacts";
import type { Cve, CveSummary } from "@/lib/cves";
import { axeViolations } from "@/app/components/ui/testing/axe";

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
  localStorage.clear();
  auth.userId = "user-1";
  setViewport(null);
  nav.search = `id=${DEVICE_ID}`;
  nav.push.mockReset();
  nav.replace.mockReset();
  // Links within the device page change its URL, like the app router.
  const follow = (href: string) => {
    if (href.startsWith("/devices/view?")) nav.go(href.slice("/devices/view?".length));
  };
  nav.push.mockImplementation(follow);
  nav.replace.mockImplementation(follow);
  workspace.locks = [];
  workspace.held = 0;
  workspace.released = 0;
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

// --- Viewport ----------------------------------------------------------------------

const viewport = vi.hoisted(() => ({ wide: true, listeners: new Set<() => void>() }));
/** `wide`: 1280px and wider; null: no media queries at all (the default in jsdom). */
function setViewport(wide: boolean | null) {
  viewport.listeners.clear();
  if (wide === null) {
    delete (window as { matchMedia?: unknown }).matchMedia;
    return;
  }
  viewport.wide = wide;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === "(min-width: 1280px)" ? viewport.wide : true;
    },
    media: query,
    addEventListener: (_: string, l: () => void) => viewport.listeners.add(l),
    removeEventListener: (_: string, l: () => void) => viewport.listeners.delete(l),
  })) as unknown as typeof window.matchMedia;
}
function resize(wide: boolean) {
  viewport.wide = wide;
  act(() => viewport.listeners.forEach((l) => l()));
}

async function renderPage(search = `id=${DEVICE_ID}`) {
  nav.search = search;
  const view = render(<DeviceViewPage />);
  await screen.findByRole("heading", { name: "Infusion Pump X" });
  return view;
}

const sectionNav = () => screen.getByRole("navigation", { name: "Device sections" });
const sectionLink = (label: string) => within(sectionNav()).getByRole("link", { name: new RegExp(`^${label}`) });
const currentSection = () => within(sectionNav()).getByRole("link", { current: "page" });
const href = (search = "") => `/devices/view?id=${DEVICE_ID}${search}`;

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
    ["&tab=cves", "Vulnerabilities"],
    ["&tab=unknown", "Overview"],
    ["&cve=rec-0001", "Vulnerabilities"],
    ["&tab=firmware&cve=rec-0001", "Vulnerabilities"],
  ])("opens the section a link names (%s → %s)", async (extra, section) => {
    await renderPage(`id=${DEVICE_ID}${extra}`);
    expect(currentSection().textContent).toMatch(new RegExp(`^${section}`));
  });

  it("links every section, Vulnerabilities as tab=cves and the RE Notebook to its own page", async () => {
    await renderPage();
    await waitFor(() => expect(sectionLink("Firmware").textContent).toBe("Firmware (2)"));
    const links = within(sectionNav()).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Overview", href()],
      ["Firmware (2)", href("&tab=firmware")],
      ["Artifacts", href("&tab=artifacts")],
      ["Images", href("&tab=images")],
      ["Vulnerabilities (2)", href("&tab=cves")],
      ["RE Notebook, opens full screen", `/devices/notebook?id=${DEVICE_ID}`],
    ]);
    expect(currentSection().textContent).toBe("Overview");
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("shows whichever section the URL names, so Back and Forward move between sections", async () => {
    await renderPage();
    expect(screen.getByText("Device information")).toBeTruthy();
    act(() => nav.go(`id=${DEVICE_ID}&tab=firmware`));
    expect(currentSection().textContent).toMatch(/^Firmware/);
    expect(await screen.findByText("pump-2.4.bin")).toBeTruthy();
    act(() => nav.go(`id=${DEVICE_ID}&tab=cves`));
    expect(currentSection().textContent).toMatch(/^Vulnerabilities/);
    expect(screen.getByText("Linked vulnerabilities")).toBeTruthy();
    // Back, twice.
    act(() => nav.go(`id=${DEVICE_ID}&tab=firmware`));
    expect(screen.getByText("pump-2.4.bin")).toBeTruthy();
    act(() => nav.go(`id=${DEVICE_ID}`));
    expect(screen.getByText("Device information")).toBeTruthy();
    // The device itself isn't requested again.
    expect(api.getDevice).toHaveBeenCalledTimes(1);
  });

  it("names the open section in the top bar's breadcrumb", async () => {
    await renderPage(`id=${DEVICE_ID}&tab=images`);
    const device = [
      { label: "Devices", href: "/devices" },
      { label: "Infusion Pump X", href: href() },
    ];
    expect(crumbs.calls.at(-1)).toEqual([...device, { label: "Images" }]);
    act(() => nav.go(`id=${DEVICE_ID}&tab=cves`));
    expect(crumbs.calls.at(-1)).toEqual([...device, { label: "Vulnerabilities" }]);
    act(() => nav.go(`id=${DEVICE_ID}`));
    expect(crumbs.calls.at(-1)).toEqual([...device, { label: "Overview" }]);
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
    expect(screen.getByText("Philips · MX800 · Infusion pump")).toBeTruthy();
    const header = document.querySelector("header")!;
    expect(header.textContent).toContain("Your access: owner");
    expect(within(header).getByText("In-Progress")).toBeTruthy();
    expect(within(header).getByText("Personal")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open RE Notebook" }).getAttribute("href")).toBe(
      `/devices/notebook?id=${DEVICE_ID}`
    );
    expect(screen.getByTestId("profile-picture")).toBeTruthy();
    expect(stubs.props.DeviceProfilePicture.canEdit).toBe(true);
    await waitFor(() => expect(sectionLink("Firmware").textContent).toBe("Firmware (2)"));
    expect(sectionLink("Vulnerabilities").textContent).toBe("Vulnerabilities (2)");
    expect(crumbs.calls.at(-1)).toEqual([
      { label: "Devices", href: "/devices" },
      { label: "Infusion Pump X", href: href() },
      { label: "Overview" },
    ]);
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
    expect(sectionLink("Vulnerabilities").textContent).toBe("Vulnerabilities (1)");
    await act(async () => finishFirst(CVES));
    expect(sectionLink("Vulnerabilities").textContent).toBe("Vulnerabilities (1)");
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
    // A history entry, like the navigation's links.
    expect(nav.push).toHaveBeenLastCalledWith(href("&tab=artifacts"), { scroll: false });
    expect(nav.replace).not.toHaveBeenCalled();
    expect(currentSection().textContent).toBe("Artifacts");
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
    expect(sectionLink("Firmware").textContent).toBe("Firmware (3)");
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
    expect(screen.getByTestId("artifact-uploader").textContent).toMatch(/^all/);
    expect(stubs.props.ArtifactUploader.fixedDevice).toMatchObject({ deviceId: DEVICE_ID });
    const calls = api.listDeviceArtifacts.mock.calls.length;
    await act(async () => (stubs.props.ArtifactUploader.onFinished as (b: string, f: number) => void)("batch-1", 1));
    expect(api.listDeviceArtifacts.mock.calls.length).toBe(calls + 1);
    expect(screen.getByTestId("artifact-uploader")).toBeTruthy();
    await act(async () => (stubs.props.ArtifactUploader.onFinished as (b: string, f: number) => void)("batch-1", 0));
    expect(screen.queryByTestId("artifact-uploader")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Upload Log" }));
    expect(screen.getByTestId("artifact-uploader").textContent).toMatch(/^log/);
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
    expect(sectionLink("Vulnerabilities").textContent).toBe("Vulnerabilities (1)");
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
    expect(sectionLink("Vulnerabilities").textContent).toBe("Vulnerabilities (1)");
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
    expect(sectionLink("Vulnerabilities").textContent).toBe("Vulnerabilities (3)");
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
    // The top bar's breadcrumb places it; the page has no trail of its own.
    expect(crumbs.calls.at(-1)).toEqual([
      { label: "Devices", href: "/devices" },
      { label: "Infusion Pump X", href: href() },
      { label: "Vulnerabilities", href: listHref },
      { label: "CVE-2024-0001" },
    ]);
    expect(screen.queryByRole("link", { name: "CVEs" })).toBeNull();
    expect(screen.queryByText("CVEs")).toBeNull();
    expect(screen.getAllByRole("link", { name: /Back to linked vulnerabilities/ }).map((a) => a.getAttribute("href"))).toEqual([
      listHref,
      listHref,
    ]);
    expect(screen.getByRole("link", { name: /Open in Vulnerabilities/ }).getAttribute("href")).toBe(
      "/vulnerabilities/view?id=rec-0001"
    );
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();

    act(() =>
      (stubs.props.CveDetails.onChanged as (c: Cve) => void)({ ...CVES[0], deviceIds: [], references: [] })
    );
    expect(sectionLink("Vulnerabilities").textContent).toBe("Vulnerabilities (1)");
    act(() => (stubs.props.CveDetails.onDeleted as (id: string) => void)("rec-0002"));
    expect(nav.push).toHaveBeenCalledWith(listHref);
    expect(sectionLink("Vulnerabilities").textContent).toBe("Vulnerabilities (0)");
  });
});

// --- Workspace layout ---------------------------------------------------------------

describe("Device workspace layout", () => {
  it("puts the sections beside the content from 1280px, collapsible to an icon rail", async () => {
    setViewport(true);
    await renderPage(`id=${DEVICE_ID}&tab=firmware`);
    expect(sectionNav().dataset.variant).toBe("panel");
    const collapse = screen.getByRole("button", { name: "Collapse device navigation" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(collapse.getAttribute("aria-controls")).toBe("device-section-links");
    await waitFor(() => expect(sectionLink("Firmware").textContent).toBe("Firmware (2)"));

    fireEvent.click(collapse);
    expect(sectionNav().hasAttribute("data-collapsed")).toBe(true);
    const expand = screen.getByRole("button", { name: "Expand device navigation" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    // The rail keeps every link named, with the open one marked, and shows
    // the name beside an icon on hover or focus.
    expect(within(sectionNav()).getAllByRole("link").map((a) => a.querySelector(".sr-only")?.textContent)).toEqual([
      "Overview",
      "Firmware (2)",
      "Artifacts",
      "Images",
      "Vulnerabilities (2)",
      "RE Notebook, opens full screen",
    ]);
    expect(within(sectionNav()).getByRole("link", { name: "Firmware (2)" }).getAttribute("aria-current")).toBe("page");
    expect(within(sectionNav()).getByRole("link", { name: "RE Notebook, opens full screen" })).toBeTruthy();
    const tips = Array.from(sectionNav().querySelectorAll("[data-rail-tooltip]")).map((t) => t.textContent);
    expect(tips).toEqual(["Overview", "Firmware", "Artifacts", "Images", "Vulnerabilities", "RE Notebook"]);
    expect(sectionNav().querySelectorAll("[data-rail-tooltip]:not([aria-hidden='true'])")).toHaveLength(0);

    fireEvent.click(expand);
    expect(sectionNav().hasAttribute("data-collapsed")).toBe(false);
  });

  it("remembers the collapsed rail per user", async () => {
    setViewport(true);
    const view = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Collapse device navigation" }));
    expect(JSON.parse(localStorage.getItem("vzoniq.layout.v1.user-1.device.nav")!)).toMatchObject({ collapsed: true });
    view.unmount();

    await renderPage();
    expect(sectionNav().hasAttribute("data-collapsed")).toBe(true);
    cleanup();

    auth.userId = "user-2";
    await renderPage();
    expect(sectionNav().hasAttribute("data-collapsed")).toBe(false);
  });

  it("uses a scrolling strip of section links below 1280px, switching as the window crosses it", async () => {
    setViewport(false);
    await renderPage(`id=${DEVICE_ID}&tab=images`);
    expect(sectionNav().dataset.variant).toBe("strip");
    expect(screen.queryByRole("button", { name: /device navigation/ })).toBeNull();
    await waitFor(() => expect(sectionLink("Firmware").textContent).toBe("Firmware (2)"));
    expect(within(sectionNav()).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      href(),
      href("&tab=firmware"),
      href("&tab=artifacts"),
      href("&tab=images"),
      href("&tab=cves"),
      `/devices/notebook?id=${DEVICE_ID}`,
    ]);
    expect(currentSection().textContent).toBe("Images");

    resize(true);
    expect(sectionNav().dataset.variant).toBe("panel");
    expect(currentSection().textContent).toBe("Images");
    resize(false);
    expect(sectionNav().dataset.variant).toBe("strip");
    // One navigation at a time.
    expect(screen.getAllByRole("navigation", { name: "Device sections" })).toHaveLength(1);
  });

  it.each([
    ["panel", true],
    ["strip", false],
  ])("has no automated accessibility violations (%s)", async (_name, wide) => {
    setViewport(wide);
    const { container } = await renderPage(`id=${DEVICE_ID}&tab=firmware`);
    await screen.findByText("pump-2.4.bin");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("names the device by whichever of manufacturer, model and type it has", async () => {
    api.getDevice.mockResolvedValue(device({ manufacturer: undefined, modelNumber: "MX800" }));
    await renderPage();
    expect(screen.getByText("MX800 · Infusion pump")).toBeTruthy();
    cleanup();
    api.getDevice.mockResolvedValue(device({ manufacturer: undefined, modelNumber: undefined, type: undefined }));
    await renderPage();
    expect(within(document.querySelector("header")!).getByText("Device")).toBeTruthy();
  });

  it("shows the workspace and the saved research status in the header", async () => {
    setScope(WS);
    api.getDevice.mockResolvedValue(device({ workspaceId: "ws-1", role: "member", reverseEngineeringStatus: "complete" }));
    await renderPage();
    const header = document.querySelector("header")!;
    expect(header.textContent).toContain("Workspace · Cardiac Lab");
    expect(within(header).getByText("Complete")).toBeTruthy();
    expect(header.textContent).toContain("Your access: member");
  });
});

// --- Upload protection ----------------------------------------------------------------

describe("Device upload protection", () => {
  const LEAVE_TITLE = "Leave while work is in progress?";
  const go = (extra = "") => act(() => nav.go(`id=${DEVICE_ID}${extra}`));
  const uploader = () => screen.getByTestId("artifact-uploader");
  const sectionOf = (el: Element) => el.closest("[data-device-section]") as HTMLElement;

  async function startArtifactUpload() {
    await renderPage(`id=${DEVICE_ID}&tab=artifacts`);
    await screen.findByText("a-1.bin");
    fireEvent.click(screen.getByRole("button", { name: "Upload new artifact" }));
    fireEvent.click(screen.getByRole("button", { name: "Start artifact upload" }));
    expect(workspace.locks.at(-1)).toBe(true);
  }

  it("keeps a running upload mounted through repeated section changes, Back and Forward", async () => {
    await startArtifactUpload();
    const original = uploader();
    expect(stubs.mounts.ArtifactUploader).toBe(1);

    // A section link, then Back, Forward, Back… (each is a URL change).
    for (const step of ["&tab=firmware", "", "&tab=images", "&tab=cves", "&tab=firmware", ""]) {
      go(step);
      expect(uploader()).toBe(original);
      const slot = sectionOf(original);
      expect(slot.hidden).toBe(true);
      expect(slot.hasAttribute("inert")).toBe(true);
      expect(screen.getByRole("status").textContent).toContain("An upload or change in Artifacts is still running.");
    }
    expect(stubs.mounts.ArtifactUploader).toBe(1);
    // The scope stays locked the whole time (never released and retaken).
    expect(workspace.held).toBe(1);
    expect(workspace.released).toBe(0);
    expect(screen.queryByRole("dialog", { name: LEAVE_TITLE })).toBeNull();

    // Back to it: shown again, the same uploader, still running.
    go("&tab=artifacts");
    expect(uploader()).toBe(original);
    expect(sectionOf(original).hidden).toBe(false);
    expect(sectionOf(original).hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("button", { name: "Finish artifact upload" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("links to the busy section from its notice, and keeps a finished one until it is seen", async () => {
    await startArtifactUpload();
    go("&tab=firmware");
    const notice = screen.getByRole("status");
    expect(within(notice).getByRole("link", { name: "Go to Artifacts" }).getAttribute("href")).toBe(href("&tab=artifacts"));
    expect(within(notice).queryByRole("button", { name: "Dismiss" })).toBeNull();

    // It finishes while out of view.
    act(() => {
      (sectionOf(uploader()).querySelector("button") as HTMLButtonElement).click();
    });
    expect(screen.getByRole("status").textContent).toContain("The upload or change in Artifacts has finished.");
    expect(uploader()).toBeTruthy();

    // Opened: the outcome is there; leaving again lets it go.
    go("&tab=artifacts");
    expect(sectionOf(uploader()).hidden).toBe(false);
    go("&tab=images");
    expect(screen.queryByTestId("artifact-uploader")).toBeNull();
  });

  it("lets a finished section's notice be dismissed", async () => {
    await startArtifactUpload();
    go("&tab=overview");
    act(() => {
      (sectionOf(uploader()).querySelector("button") as HTMLButtonElement).click();
    });
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("artifact-uploader")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a firmware upload dialog (and its upload) through Back to another section", async () => {
    await renderPage(`id=${DEVICE_ID}&tab=firmware`);
    fireEvent.click(screen.getByRole("button", { name: "Upload firmware" }));
    fireEvent.click(screen.getByRole("button", { name: "Start firmware upload" }));
    go();
    const dialog = document.querySelector('[aria-label="Upload firmware dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(sectionOf(dialog).hidden).toBe(true);
    expect(stubs.mounts.FirmwareUploadDialog).toBe(1);
    go("&tab=firmware");
    expect(screen.getByRole("dialog", { name: "Upload firmware dialog" })).toBeTruthy();
    expect(stubs.mounts.FirmwareUploadDialog).toBe(1);
  });

  it("mounts only the open section when nothing is running", async () => {
    await renderPage(`id=${DEVICE_ID}&tab=artifacts`);
    await screen.findByText("a-1.bin");
    fireEvent.click(screen.getByRole("button", { name: "Upload new artifact" }));
    go("&tab=firmware");
    // A staged but unstarted uploader goes, as before.
    expect(screen.queryByTestId("artifact-uploader")).toBeNull();
    expect(document.querySelectorAll("[data-device-section]")).toHaveLength(1);
  });

  it("asks before a link leaves the device page while work is in progress", async () => {
    setScope({ kind: "personal" }, { scopeLocked: true });
    await renderPage(`id=${DEVICE_ID}&tab=cves`);
    await screen.findByRole("list", { name: "Linked CVE list" });

    // Another section of this device stays on the page: no question.
    expect(fireEvent.click(sectionLink("Firmware"))).toBe(true);
    expect(screen.queryByRole("dialog", { name: LEAVE_TITLE })).toBeNull();

    for (const name of ["All vulnerabilities", "Open RE Notebook"]) {
      expect(fireEvent.click(screen.getByRole("link", { name }))).toBe(false);
      expect(screen.getByRole("dialog", { name: LEAVE_TITLE })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog", { name: LEAVE_TITLE })).toBeNull();
    }
    expect(nav.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "Open RE Notebook" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    expect(nav.push).toHaveBeenCalledWith(`/devices/notebook?id=${DEVICE_ID}`);
  });

  it("asks the browser to confirm reloading or closing while work is in progress", async () => {
    setScope({ kind: "personal" }, { scopeLocked: true });
    await renderPage();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("changes nothing about navigation when nothing is in progress", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    await renderPage(`id=${DEVICE_ID}&tab=artifacts`);
    await screen.findByText("a-1.bin");
    fireEvent.click(screen.getByRole("link", { name: "Open RE Notebook" }));
    expect(screen.queryByRole("dialog", { name: LEAVE_TITLE })).toBeNull();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(pushState).not.toHaveBeenCalled();
    pushState.mockRestore();
  });
});
