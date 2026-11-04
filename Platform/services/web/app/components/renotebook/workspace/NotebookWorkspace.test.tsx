// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
vi.mock("@/context/WorkspaceContext", () => ({
  useScopeLock: () => undefined,
  ScopeLockReporter: ({ children }: { children: React.ReactNode }) => children,
}));
// The gallery uploader has its own tests: here it reports one ready upload.
vi.mock("@/app/components/ArtifactUploader", () => ({
  default: ({ onFinished }: { onFinished: (batch: string | undefined, failed: number, ready: string[]) => void }) => (
    <button type="button" onClick={() => onFinished("b1", 0, ["0192d000-0000-7000-8000-0000000000aa"])}>
      Fake upload
    </button>
  ),
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { userId: "user-1", username: "u" }, loading: false }) }));
// The real menu reads the signed-in user's attributes from Cognito.
vi.mock("@/app/components/shell/UserMenu", () => ({ default: () => <span>user menu</span> }));

import { ApiError, apiRequest } from "@/lib/api";
import type { Artifact } from "@/lib/artifacts";
import type { Device } from "@/lib/devices";
import type { ImageArtifact } from "@/lib/images";
import type { Notebook, NotebookEntry, NotebookSection } from "@/lib/reNotebook";
import type { NotebookDoc } from "@/lib/reNotebookDoc";
import { PANEL_LIMITS } from "@/lib/reNotebookLayout";
import NotebookWorkspace from "./NotebookWorkspace";
import ConflictDialog from "../ConflictDialog";

const request = vi.mocked(apiRequest);
const D = "11111111-1111-4111-8111-000000000001";
const device = { deviceId: D, name: "Alfa AWUS036ACH", type: "wifi", role: "owner" } as Device;
const BASE = `/devices/${D}/notebook`;
const LAYOUT_KEY = "vzoniq.reNotebook.layout.v1.user-1";

function entry(id: string, sectionId: string, title: string, patch: Partial<NotebookEntry> = {}): NotebookEntry {
  return {
    entryId: id, sectionId, title, version: 1, contentVersion: 1, textLength: 0,
    createdBy: "user-1", createdByName: "Ipule", createdAt: "2026-11-02T12:00:00Z",
    updatedBy: "user-1", updatedByName: "Ipule", updatedAt: "2026-11-02T12:00:00Z",
    contentUpdatedBy: "user-1", contentUpdatedByName: "Ipule", contentUpdatedAt: "2026-11-02T12:00:00Z", ...patch,
  };
}

function section(id: string, title: string, entries: NotebookEntry[], patch: Partial<NotebookSection> = {}): NotebookSection {
  return {
    sectionId: id, title, version: 1, orderVersion: entries.length, entries,
    createdBy: null, createdByName: null, createdAt: null, updatedBy: null, updatedByName: null, updatedAt: null, ...patch,
  };
}

function notebook(sections: NotebookSection[], orderVersion = sections.length): Notebook {
  return {
    deviceId: D, orderVersion, sections,
    limits: { sections: 50, entriesPerSection: 200, titleLength: 200, documentBytes: 307200 },
  };
}

const paragraph = (text: string): NotebookDoc => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const full = () =>
  notebook([
    section("s1", "Physical Teardown", [entry("e1", "s1", "Opening the device"), entry("e2", "s1", "Chipset identification")]),
    section("s2", "Firmware Analysis", []),
  ]);

type Handler = (body: unknown, query: unknown) => unknown;
let routes: Record<string, Handler>;
let calls: string[];

beforeEach(() => {
  localStorage.clear();
  routes = {
    // The context panel: the device's artifacts and images.
    [`GET /devices/${D}/artifacts`]: () => ({ artifacts: [] }),
  };
  calls = [];
  request.mockReset();
  request.mockImplementation(async (method, path, options) => {
    calls.push(`${method} ${path}`);
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(options?.body, options?.query) as never;
  });
});
afterEach(cleanup);

function renderWorkspace(props: Partial<React.ComponentProps<typeof NotebookWorkspace>> = {}) {
  const onBack = vi.fn();
  const onLocationChange = vi.fn();
  render(
    <NotebookWorkspace
      device={device}
      scope={{ kind: "personal" }}
      onBack={onBack}
      onLocationChange={onLocationChange}
      {...props}
    />
  );
  return { onBack, onLocationChange };
}

function openMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  const menus = screen.getAllByRole("menu");
  return menus[menus.length - 1];
}

/** The workspace's top bar (the open entry has a header of its own). */
const topBar = () => screen.getAllByRole("banner")[0];
const entriesNav = () => screen.getByRole("navigation", { name: /^Entries in / });
const entryButtons = () =>
  within(entriesNav()).getAllByRole("button", { name: /^(Opening the device|Chipset identification)$/ });

function withEntries() {
  routes[`GET ${BASE}`] = () => ({ notebook: full() });
  routes[`GET ${BASE}/entries/e1`] = () => ({ entry: full().sections[0].entries[0], doc: paragraph("four screws") });
  routes[`GET ${BASE}/entries/e2`] = () => ({ entry: full().sections[0].entries[1], doc: paragraph("Realtek RTL8812AU") });
}

describe("NotebookWorkspace: notebook structure", () => {
  it("starts an empty notebook with its first section", async () => {
    routes[`GET ${BASE}`] = () => ({ notebook: notebook([]) });
    routes[`POST ${BASE}/sections`] = (body) => {
      expect(body).toEqual({ title: "Physical Teardown" });
      return { sectionId: "s1", notebook: notebook([section("s1", "Physical Teardown", [])]) };
    };
    renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "Create the first section" }));
    fireEvent.change(screen.getByLabelText("Section title"), { target: { value: "  Physical Teardown " } });
    fireEvent.click(screen.getByRole("button", { name: "Create section" }));
    const tab = await screen.findByRole("tab", { name: /Physical Teardown/ });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("No entries in Physical Teardown yet")).toBeTruthy();
  });

  it("shows sections as tabs, the section's entries in order, and opens the linked entry", async () => {
    withEntries();
    const { onLocationChange } = renderWorkspace({ initialEntryId: "e2" });
    expect(await screen.findByRole("heading", { name: "Chipset identification", level: 2 })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(entryButtons().map((b) => b.getAttribute("aria-label"))).toEqual(["Opening the device", "Chipset identification"]);
    expect(within(entriesNav()).getByRole("button", { name: "Chipset identification" }).getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(screen.getByText("Realtek RTL8812AU")).toBeTruthy());
    // The save state shows in the top bar.
    expect(topBar().querySelector('[role="status"]')?.textContent).toMatch(/Saved/);
    expect(onLocationChange).not.toHaveBeenCalled();
  });

  it("opens the first entry when no entry is linked", async () => {
    withEntries();
    const { onLocationChange } = renderWorkspace();
    expect(await screen.findByText("four screws")).toBeTruthy();
    expect(onLocationChange).toHaveBeenCalledWith("s1", "e1");
  });

  it("opens the linked section, and says so when a linked entry is gone", async () => {
    withEntries();
    const { onLocationChange } = renderWorkspace({ initialEntryId: "gone", initialSectionId: "s2" });
    expect(await screen.findByText("That entry isn't in the notebook any more.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Firmware Analysis/ }).getAttribute("aria-selected")).toBe("true");
    expect(onLocationChange).toHaveBeenCalledWith("s2", null);
    // Not mistaken for an entry someone deleted while it was open.
    expect(screen.queryByText(/deleted by someone else/)).toBeNull();
  });

  it("opens the first entry when a linked entry is gone and no section is linked", async () => {
    withEntries();
    const { onLocationChange } = renderWorkspace({ initialEntryId: "gone" });
    expect(await screen.findByText("four screws")).toBeTruthy();
    expect(onLocationChange).toHaveBeenCalledWith("s1", "e1");
    expect(screen.getByText("That entry isn't in the notebook any more.")).toBeTruthy();
  });

  it("switches sections from the tabs, with the arrow keys too", async () => {
    withEntries();
    const { onLocationChange } = renderWorkspace();
    await screen.findByText("four screws");
    fireEvent.click(screen.getByRole("tab", { name: /Firmware Analysis/ }));
    expect(await screen.findByText("No entries in Firmware Analysis yet")).toBeTruthy();
    expect(onLocationChange).toHaveBeenLastCalledWith("s2", null);
    fireEvent.keyDown(screen.getByRole("tab", { name: /Firmware Analysis/ }), { key: "ArrowLeft" });
    expect(await screen.findByText("four screws")).toBeTruthy();
    expect(onLocationChange).toHaveBeenLastCalledWith("s1", "e1");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Physical Teardown/ }));
  });

  it("only offers deleting a section once it is empty", async () => {
    withEntries();
    renderWorkspace();
    await screen.findByText("four screws");
    let menu = openMenu("Actions for section Physical Teardown");
    expect((within(menu).getByRole("menuitem", { name: /Delete section/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Actions for section Physical Teardown" }));
    fireEvent.click(screen.getByRole("tab", { name: /Firmware Analysis/ }));
    menu = openMenu("Actions for section Firmware Analysis");
    expect((within(menu).getByRole("menuitem", { name: "Delete section" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(menu).getByRole("menuitem", { name: "Move section left" })).toBeTruthy();
  });

  it("moves an entry down with the version it was based on", async () => {
    withEntries();
    const reordered = full();
    reordered.sections[0].entries.reverse();
    routes[`PUT ${BASE}/sections/s1/entry-order`] = (body) => {
      expect(body).toEqual({ entryIds: ["e2", "e1"], expectedOrderVersion: 2 });
      return { notebook: reordered };
    };
    renderWorkspace();
    await screen.findByText("four screws");
    fireEvent.click(within(openMenu("Actions for entry Opening the device")).getByRole("menuitem", { name: "Move down" }));
    await waitFor(() =>
      expect(entryButtons().map((b) => b.getAttribute("aria-label"))).toEqual(["Chipset identification", "Opening the device"])
    );
  });

  it("explains a change refused because someone else changed the notebook, and shows theirs", async () => {
    withEntries();
    const theirs = full();
    theirs.sections[0].entries.push(entry("e9", "s1", "Added by a colleague"));
    routes[`PUT ${BASE}/sections/s1/entry-order`] = () => {
      throw new ApiError("The section was changed by someone else", 409, { code: "stale_order", notebook: theirs });
    };
    renderWorkspace();
    await screen.findByText("four screws");
    fireEvent.click(within(openMenu("Actions for entry Opening the device")).getByRole("menuitem", { name: "Move down" }));
    expect(await screen.findByText(/someone else changed the notebook at the same time/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Added by a colleague" })).toBeTruthy();
  });

  it("deletes an entry after confirming, with the versions it last saw", async () => {
    withEntries();
    const after = full();
    after.sections[0].entries.splice(1, 1);
    routes[`DELETE ${BASE}/entries/e2`] = (_body, query) => {
      expect(query).toEqual({ expectedVersion: 1, expectedContentVersion: 1 });
      return { notebook: after };
    };
    renderWorkspace();
    await screen.findByText("four screws");
    fireEvent.click(within(openMenu("Actions for entry Chipset identification")).getByRole("menuitem", { name: "Delete entry" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/kept in the database/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete entry" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Chipset identification" })).toBeNull());
  });

  it("closes the open entry when someone else deleted it, and says so", async () => {
    withEntries();
    const theirs = full();
    theirs.sections[0].entries.shift(); // e1, the open entry, is gone
    routes[`PUT ${BASE}/sections/s1/entry-order`] = () => {
      throw new ApiError("The section was changed by someone else", 409, { code: "stale_order", notebook: theirs });
    };
    renderWorkspace();
    await screen.findByText("four screws");
    fireEvent.click(within(openMenu("Actions for entry Opening the device")).getByRole("menuitem", { name: "Move down" }));
    expect(await screen.findByText("The entry you had open was deleted by someone else.")).toBeTruthy();
    expect(screen.queryByText("four screws")).toBeNull();
    expect(screen.getByText("Select an entry")).toBeTruthy();
  });

  it("offers the open entry's actions in its header", async () => {
    withEntries();
    renderWorkspace();
    await screen.findByText("four screws");
    const menu = openMenu("Entry actions");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Rename entry",
      "Move down",
      "Move to section…",
      "Delete entry",
    ]);
  });

  it("shows why the notebook couldn't load, with a retry", async () => {
    let attempts = 0;
    routes[`GET ${BASE}`] = () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError("Device not found", 404);
      return { notebook: notebook([]) };
    };
    renderWorkspace();
    expect(await screen.findByText("Device not found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Create the first section" })).toBeTruthy();
  });

  it("goes back to the device once nothing is left unsaved", async () => {
    withEntries();
    const { onBack } = renderWorkspace();
    await screen.findByText("four screws");
    fireEvent.click(screen.getByRole("button", { name: "Back to Device" }));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });
});

describe("NotebookWorkspace: panels", () => {
  const entriesPanel = () => document.getElementById("re-notebook-entries-panel")!;
  const contextPanel = () => document.getElementById("re-notebook-context-panel")!;
  const isHidden = (el: HTMLElement) => el.classList.contains("hidden");

  it("collapses and restores the side panels without reopening the entry", async () => {
    withEntries();
    renderWorkspace();
    await screen.findByText("four screws");
    const editorNode = document.querySelector(".re-notebook-doc");
    expect(isHidden(entriesPanel())).toBe(false);
    expect(isHidden(contextPanel())).toBe(false);

    const hideEntries = screen.getByRole("button", { name: "Hide the entries panel" });
    expect(hideEntries.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hideEntries);
    expect(isHidden(entriesPanel())).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hide the device context panel" }));
    expect(isHidden(contextPanel())).toBe(true);
    // Each collapsed panel leaves a strip that brings it back.
    const rails = screen.getAllByRole("button", { name: "Show the entries panel" });
    expect(rails).toHaveLength(2);
    fireEvent.click(rails[1]);
    expect(isHidden(entriesPanel())).toBe(false);

    // The same editor throughout: its unsaved changes and autosave are untouched.
    expect(document.querySelector(".re-notebook-doc")).toBe(editorNode);
    expect(calls.filter((c) => c === `GET ${BASE}/entries/e1`)).toHaveLength(1);
    // Remembered for this user.
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toMatchObject({ leftCollapsed: false, rightCollapsed: true });
  });

  it("starts with the panels as this user left them", async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ leftWidth: 300, rightWidth: 400, leftCollapsed: true, rightCollapsed: true }));
    withEntries();
    renderWorkspace();
    await screen.findByText("four screws");
    expect(isHidden(entriesPanel())).toBe(true);
    expect(isHidden(contextPanel())).toBe(true);
    // A collapsed context panel hasn't loaded anything.
    expect(calls.some((c) => c.startsWith(`GET /devices/${D}/artifacts`))).toBe(false);
  });

  it("resizes a panel with the keyboard and remembers the width", async () => {
    withEntries();
    renderWorkspace();
    await screen.findByText("four screws");
    const handle = screen.getByRole("separator", { name: "Resize the entries panel" });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(PANEL_LIMITS.left.initial));
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(PANEL_LIMITS.left.initial + 16));
    expect(entriesPanel().style.width).toBe(`${PANEL_LIMITS.left.initial + 16}px`);
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(PANEL_LIMITS.left.max));
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).leftWidth).toBe(PANEL_LIMITS.left.max);

    const right = screen.getByRole("separator", { name: "Resize the device context panel" });
    fireEvent.keyDown(right, { key: "ArrowLeft", shiftKey: true });
    expect(right.getAttribute("aria-valuenow")).toBe(String(PANEL_LIMITS.right.initial + 64));
  });

  it("Focus Mode keeps only Back, the save state and Exit, and Escape leaves it", async () => {
    withEntries();
    renderWorkspace();
    await screen.findByText("four screws");
    const editorNode = document.querySelector(".re-notebook-doc");
    fireEvent.click(screen.getByRole("button", { name: "Focus Mode" }));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(isHidden(entriesPanel())).toBe(true);
    expect(isHidden(contextPanel())).toBe(true);
    const banner = within(topBar());
    expect(banner.getByRole("button", { name: "Back to Device" })).toBeTruthy();
    expect(banner.getByRole("status").textContent).toMatch(/Saved/);
    expect(banner.queryByText("user menu")).toBeNull();
    expect(banner.queryByRole("button", { name: /entries panel/ })).toBeNull();
    expect(document.querySelector(".re-notebook-doc")).toBe(editorNode);

    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(isHidden(entriesPanel())).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Focus Mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Exit Focus Mode" }));
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(document.querySelector(".re-notebook-doc")).toBe(editorNode);
  });
});

describe("NotebookWorkspace: keyboard shortcuts", () => {
  it("toggle the panels and Focus Mode with Ctrl+Alt, but not with AltGr", async () => {
    withEntries();
    renderWorkspace();
    await screen.findByText("four screws");
    const entries = document.getElementById("re-notebook-entries-panel")!;
    const context = document.getElementById("re-notebook-context-panel")!;
    fireEvent.keyDown(document.body, { code: "BracketLeft", key: "[", ctrlKey: true, altKey: true });
    expect(entries.classList.contains("hidden")).toBe(true);
    fireEvent.keyDown(document.body, { code: "BracketRight", key: "]", ctrlKey: true, altKey: true });
    expect(context.classList.contains("hidden")).toBe(true);
    fireEvent.keyDown(document.body, { code: "BracketLeft", key: "[", ctrlKey: true, altKey: true });
    expect(entries.classList.contains("hidden")).toBe(false);
    fireEvent.keyDown(document.body, { code: "KeyF", key: "f", ctrlKey: true, altKey: true });
    expect(screen.getByRole("button", { name: "Exit Focus Mode" })).toBeTruthy();
    fireEvent.keyDown(document.body, { code: "KeyF", key: "f", ctrlKey: true, altKey: true });
    expect(screen.getByRole("tablist")).toBeTruthy();

    // AltGr (reported as Ctrl+Alt) types characters on some keyboards.
    const altGr = new KeyboardEvent("keydown", { code: "BracketLeft", key: "{", ctrlKey: true, altKey: true, bubbles: true });
    Object.defineProperty(altGr, "getModifierState", { value: (key: string) => key === "AltGraph" });
    act(() => {
      document.body.dispatchEvent(altGr);
    });
    expect(entries.classList.contains("hidden")).toBe(false);
  });
});

describe("NotebookWorkspace: device context", () => {
  const artifact = (patch: Partial<Artifact>): Artifact =>
    ({
      artifactId: "a1", name: "boot-log.pcap", type: "pcap", status: "ready", sizeBytes: 15 * 1024 * 1024,
      createdAt: "2026-10-28T10:00:00Z", uploadedAt: "2026-10-28T10:00:00Z", originalFilename: "boot-log.pcap",
      deviceIds: [D], tags: [], ...patch,
    }) as Artifact;

  it("lists the device's artifacts and images read-only, and downloads without leaving the page", async () => {
    withEntries();
    routes[`GET /devices/${D}/artifacts`] = (_body, query) => {
      const q = query as { type?: string };
      if (q.type === "image") return { artifacts: [] };
      if (q.type === "firmware") return { artifacts: [artifact({ artifactId: "a2", name: "firmware.bin", type: "firmware" })] };
      return { artifacts: [artifact({})] };
    };
    routes[`GET /artifacts/a1/download`] = () => ({ url: "https://files.example/boot-log.pcap" });
    renderWorkspace();
    await screen.findByText("four screws");
    const panel = within(document.getElementById("re-notebook-context-panel")!);
    expect(await panel.findByText("boot-log.pcap")).toBeTruthy();
    expect(panel.getByText(/PCAP · 15\.0 MiB/)).toBeTruthy();
    expect(await panel.findByText("No images of this device yet.")).toBeTruthy();
    // Read-only: nothing to upload, edit or delete.
    expect(panel.queryByRole("button", { name: /upload|edit|delete|replace|link/i })).toBeNull();

    fireEvent.click(panel.getByRole("button", { name: "Download boot-log.pcap" }));
    await waitFor(() => expect(document.querySelector('iframe[src="https://files.example/boot-log.pcap"]')).toBeTruthy());

    fireEvent.change(panel.getByLabelText("Artifact type"), { target: { value: "firmware" } });
    expect(await panel.findByText("firmware.bin")).toBeTruthy();
    expect(panel.queryByText("boot-log.pcap")).toBeNull();
  });
});

describe("NotebookWorkspace: images", () => {
  const IMG_1 = "0192d000-0000-7000-8000-000000000001";
  const IMG_2 = "0192d000-0000-7000-8000-000000000002";
  const galleryImage = (artifactId: string, title: string): ImageArtifact =>
    ({
      artifactId, name: `${title}.png`, type: "image", status: "ready", statusReason: null, sizeBytes: 1000,
      originalFilename: `${title}.png`, tags: [], deviceIds: [D], attemptId: "t", createdAt: "2026-10-01T10:00:00Z",
      uploadedAt: null, title, description: null, mimeType: "image/png", capturedAt: null, updatedAt: null,
    }) as unknown as ImageArtifact;
  const withImage = (...artifactIds: string[]): NotebookDoc => ({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "four screws" }] },
      ...artifactIds.map((artifactId, i) => ({ type: "image", attrs: { artifactId, alt: `Photo ${i + 1}` } })),
    ],
  });
  /** Answers view-URL requests: a URL for each id in `ok`, 404 for the rest. */
  function viewUrls(ok: string[]) {
    routes["POST /artifacts/view-urls"] = (body) => ({
      results: (body as { artifactIds: string[] }).artifactIds.map((artifactId) =>
        ok.includes(artifactId)
          ? { artifactId, ok: true, url: `https://s3.example/${artifactId}?sig=1`, mimeType: "image/png", expiresIn: 300 }
          : { artifactId, ok: false, status: 404, error: "Image not found" }
      ),
    });
  }
  const viewUrlCalls = () =>
    request.mock.calls.filter(([method, path]) => method === "POST" && path === "/artifacts/view-urls");

  it("shows an entry's images through short-lived URLs, and a placeholder for one that's gone", async () => {
    withEntries();
    routes[`GET ${BASE}/entries/e1`] = () => ({ entry: full().sections[0].entries[0], doc: withImage(IMG_1, IMG_2) });
    viewUrls([IMG_1]);
    renderWorkspace();
    const img = (await screen.findByAltText("Photo 1")) as HTMLImageElement;
    expect(img.src).toBe(`https://s3.example/${IMG_1}?sig=1`);
    expect(await screen.findByText("Image unavailable")).toBeTruthy();
    expect(screen.getByText("Photo 2")).toBeTruthy(); // the placeholder names the missing image
    // One request for both images.
    expect(viewUrlCalls()).toHaveLength(1);
    expect((viewUrlCalls()[0][2] as { body: { artifactIds: string[] } }).body.artifactIds.sort()).toEqual([IMG_1, IMG_2]);
  });

  it("inserts a gallery image by its id, and autosave stores only the id", async () => {
    // jsdom has no layout: ProseMirror scrolls the inserted image into view.
    const range = Range.prototype as unknown as Record<string, unknown>;
    range.getClientRects = () => [];
    range.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
    onTestFinished(() => {
      delete range.getClientRects;
      delete range.getBoundingClientRect;
    });
    withEntries();
    viewUrls([IMG_1]);
    routes[`GET /devices/${D}/artifacts`] = (_body, query) =>
      (query as { type?: string }).type === "image" ? { artifacts: [galleryImage(IMG_1, "PCB top")] } : { artifacts: [] };
    const saves: unknown[] = [];
    routes[`PUT ${BASE}/entries/e1/content`] = (body) => {
      saves.push(body);
      return { entry: entry("e1", "s1", "Opening the device", { contentVersion: 2 }) };
    };
    renderWorkspace();
    await screen.findByText("four screws");
    fireEvent.click(screen.getByRole("button", { name: "Insert image" }));
    const dialog = within(await screen.findByRole("dialog", { name: /Insert image/ }));
    const insert = dialog.getByRole("button", { name: "Insert image" });
    expect((insert as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await dialog.findByRole("button", { name: "Select PCB top" }));
    fireEvent.click(insert);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Insert image/ })).toBeNull());

    // Shown in the entry with a view URL ...
    const shown = await waitFor(() => {
      const img = document.querySelector<HTMLImageElement>('.re-notebook-doc img[alt="PCB top"]');
      expect(img).toBeTruthy();
      return img!;
    });
    expect(shown.src).toBe(`https://s3.example/${IMG_1}?sig=1`);
    // The editor has focus again, for typing on after the image.
    await waitFor(() => expect(document.activeElement?.classList.contains("ProseMirror")).toBe(true));
    // ... but saved as a reference only.
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 5000 });
    const saved = saves[0] as { doc: NotebookDoc; expectedContentVersion: number };
    expect(saved.expectedContentVersion).toBe(1);
    expect(saved.doc.content).toContainEqual({ type: "image", attrs: { artifactId: IMG_1, alt: "PCB top" } });
    expect(JSON.stringify(saved)).not.toMatch(/https?:|s3\.example|sig=/);
  }, 10000);

  it("inserts a newly uploaded image and shows it in the context panel at once", async () => {
    const range = Range.prototype as unknown as Record<string, unknown>;
    range.getClientRects = () => [];
    range.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
    onTestFinished(() => {
      delete range.getClientRects;
      delete range.getBoundingClientRect;
    });
    const NEW = "0192d000-0000-7000-8000-0000000000aa";
    withEntries();
    viewUrls([NEW]);
    let uploaded = false;
    routes[`GET /devices/${D}/artifacts`] = (_body, query) =>
      (query as { type?: string }).type === "image" && uploaded ? { artifacts: [galleryImage(NEW, "Serial header")] } : { artifacts: [] };
    routes[`GET /artifacts/${NEW}`] = () => ({ artifact: galleryImage(NEW, "Serial header") });
    routes[`PUT ${BASE}/entries/e1/content`] = () => ({ entry: entry("e1", "s1", "Opening the device", { contentVersion: 2 }) });
    renderWorkspace();
    await screen.findByText("four screws");
    const panel = within(document.getElementById("re-notebook-context-panel")!);
    expect(await panel.findByText("No images of this device yet.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Insert image" }));
    const dialog = within(await screen.findByRole("dialog", { name: /Insert image/ }));
    fireEvent.click(dialog.getByRole("tab", { name: "Upload new" }));
    uploaded = true;
    fireEvent.click(dialog.getByRole("button", { name: "Fake upload" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Insert image/ })).toBeNull());

    await waitFor(() => expect(document.querySelector('.re-notebook-doc img[alt="Serial header"]')).toBeTruthy());
    // The context panel's gallery reloaded without a page refresh.
    expect(await panel.findByRole("button", { name: /Serial header/ })).toBeTruthy();
  }, 10000);

  it("offers no Insert image to a workspace viewer", async () => {
    withEntries();
    renderWorkspace({ device: { ...device, workspaceId: "w1", role: "viewer" } as Device, scope: { kind: "workspace", workspaceId: "w1", name: "Lab", role: "viewer" } });
    await screen.findByText("four screws");
    expect(screen.queryByRole("button", { name: "Insert image" })).toBeNull();
  });
});

describe("NotebookWorkspace: Export PDF", () => {
  const IMG_1 = "0192d000-0000-7000-8000-000000000001";
  let print: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    print = vi.spyOn(window, "print").mockImplementation(() => undefined);
  });
  afterEach(() => print.mockRestore());

  const printRoot = () => document.querySelector<HTMLElement>(".re-notebook-print");
  /** jsdom never loads images: tells the export each one loaded. */
  async function loadPrintImages(count: number) {
    await waitFor(() => expect(printRoot()?.querySelectorAll("img").length).toBe(count));
    printRoot()!.querySelectorAll("img").forEach((img) => fireEvent.load(img));
  }

  it("prints every section and entry in order, with their images, once all are loaded", async () => {
    withEntries();
    routes[`GET ${BASE}/entries/e2`] = () => ({
      entry: full().sections[0].entries[1],
      doc: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "RTL8812AU" }] },
          { type: "image", attrs: { artifactId: IMG_1, alt: "Chip close-up" } },
          { type: "codeBlock", content: [{ type: "text", text: "lsusb -v" }] },
        ],
      },
    });
    routes["POST /artifacts/view-urls"] = (body) => ({
      results: (body as { artifactIds: string[] }).artifactIds.map((artifactId) => ({
        artifactId, ok: true, url: `https://s3.example/${artifactId}`, mimeType: "image/png", expiresIn: 300,
      })),
    });
    renderWorkspace();
    await screen.findByText("four screws");
    calls = [];
    fireEvent.click(within(topBar()).getByRole("button", { name: "Export PDF" }));
    expect(await screen.findByRole("dialog", { name: /Export PDF/ })).toBeTruthy();
    expect(document.body.classList.contains("re-notebook-printing")).toBe(true);

    await loadPrintImages(1);
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    // Read fresh: the notebook, then each entry.
    expect(calls).toEqual(expect.arrayContaining([`GET ${BASE}`, `GET ${BASE}/entries/e1`, `GET ${BASE}/entries/e2`]));

    const root = printRoot()!;
    expect(root.querySelector("h1")!.textContent).toBe(device.name);
    expect([...root.querySelectorAll(".re-notebook-print-section-title")].map((h) => h.textContent)).toEqual([
      "Physical Teardown",
      "Firmware Analysis",
    ]);
    expect([...root.querySelectorAll(".re-notebook-print-entry-title")].map((h) => h.textContent)).toEqual([
      "Opening the device",
      "Chipset identification",
    ]);
    expect(within(root).getByText("four screws")).toBeTruthy();
    expect(within(root).getByRole("heading", { name: "RTL8812AU", hidden: true })).toBeTruthy();
    expect(within(root).getByText("lsusb -v").closest("pre")).toBeTruthy();
    expect(within(root).getByAltText("Chip close-up").getAttribute("loading")).toBe("eager");
    expect(within(root).getByText("No entries in this section.")).toBeTruthy();
    // The contents list every section and entry.
    expect(within(root.querySelector("nav")!).getAllByRole("listitem", { hidden: true }).map((li) => li.firstChild?.textContent)).toEqual([
      "Physical Teardown",
      "Opening the device",
      "Chipset identification",
      "Firmware Analysis",
    ]);

    const exportDialog = within(screen.getByRole("dialog", { name: /Export PDF/ }));
    fireEvent.click(exportDialog.getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(printRoot()).toBeNull());
    expect(document.body.classList.contains("re-notebook-printing")).toBe(false);
  });

  it("says what's missing and waits for the user before printing", async () => {
    withEntries();
    routes[`GET ${BASE}/entries/e1`] = () => ({
      entry: full().sections[0].entries[0],
      doc: { type: "doc", content: [{ type: "image", attrs: { artifactId: IMG_1, alt: "Gone" } }] },
    });
    routes["POST /artifacts/view-urls"] = (body) => ({
      results: (body as { artifactIds: string[] }).artifactIds.map((artifactId) => ({ artifactId, ok: false, status: 404, error: "Image not found" })),
    });
    renderWorkspace();
    await screen.findByText("Image unavailable");
    let failE2 = true;
    routes[`GET ${BASE}/entries/e2`] = () => {
      if (failE2) throw new ApiError("Internal error", 500);
      return { entry: full().sections[0].entries[1], doc: paragraph("x") };
    };
    fireEvent.click(within(topBar()).getByRole("button", { name: "Export PDF" }));
    const dialog = within(await screen.findByRole("dialog", { name: /Export PDF/ }));
    expect(await dialog.findByText(/One entry couldn't be read/)).toBeTruthy();
    expect(dialog.getByText(/“Chipset identification”/)).toBeTruthy();
    expect(dialog.getByText(/One image couldn't be shown/)).toBeTruthy();
    expect(within(printRoot()!).getByText(/This entry couldn't be read for the export/)).toBeTruthy();
    expect(print).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Print anyway" }));
    expect(print).toHaveBeenCalledTimes(1);
    failE2 = false;
  });

  it("is offered to workspace viewers, and names the workspace", async () => {
    withEntries();
    renderWorkspace({ device: { ...device, workspaceId: "w1", role: "viewer" } as Device, scope: { kind: "workspace", workspaceId: "w1", name: "Lab", role: "viewer" } });
    await screen.findByText("four screws");
    fireEvent.click(within(topBar()).getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(within(printRoot()!).getByText(/^Lab · Exported/)).toBeTruthy();
  });

  it("isn't offered for a notebook without sections", async () => {
    routes[`GET ${BASE}`] = () => ({ notebook: notebook([]) });
    renderWorkspace();
    await screen.findByRole("button", { name: "Create the first section" });
    expect(screen.queryByRole("button", { name: "Export PDF" })).toBeNull();
  });
});

describe("ConflictDialog", () => {
  function renderDialog() {
    const onKeepBoth = vi.fn(async () => null);
    const onUseTheirs = vi.fn();
    render(
      <ConflictDialog
        title="Chipset identification"
        mine={paragraph("my findings")}
        theirs={paragraph("their findings")}
        theirEntry={entry("e2", "s1", "Chipset identification", { contentUpdatedByName: "Colleague", contentVersion: 3 })}
        onKeepBoth={onKeepBoth}
        onUseTheirs={onUseTheirs}
        onClose={() => undefined}
      />
    );
    return { onKeepBoth, onUseTheirs };
  }

  it("shows both versions and never offers to overwrite theirs", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("my findings")).toBeTruthy());
    expect(screen.getByText("their findings")).toBeTruthy();
    expect(screen.getByText(/Colleague saved a new version/)).toBeTruthy();
    const labels = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(labels.some((l) => /overwrite|replace theirs|force/i.test(l))).toBe(false);
  });

  it("keeps both, or discards mine only after confirming", async () => {
    const { onKeepBoth, onUseTheirs } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /Keep both/ }));
    await waitFor(() => expect(onKeepBoth).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Use their version" }));
    expect(onUseTheirs).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard my changes" }));
    expect(onUseTheirs).toHaveBeenCalled();
  });
});

describe("NotebookWorkspace: read-only for a workspace viewer", () => {
  const W = "0192b000-0000-7000-8000-000000000001";
  const viewerDevice = { ...device, role: "viewer", workspaceId: W } as Device;
  const viewerScope = { kind: "workspace" as const, workspaceId: W, name: "Senior Design", role: "viewer" as const };

  it("shows entries without an editor, structure controls or autosave", async () => {
    withEntries();
    renderWorkspace({ device: viewerDevice, scope: viewerScope });

    // The saved content is shown, in a read-only view: nothing on the page is editable.
    expect(await screen.findByText("four screws")).toBeTruthy();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    const view = screen.getByLabelText("Content of Opening the device");
    expect(view.getAttribute("aria-readonly")).toBe("true");
    expect(view.getAttribute("contenteditable")).toBe("false");

    // Nothing that changes the notebook is offered.
    for (const name of [/Add section/, /^New entry/, "Entry actions", /^Actions for section/, /^Actions for entry/]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    // No save state either: nothing is ever saved.
    expect(within(topBar()).queryByText(/Saved|Saving|Unsaved/)).toBeNull();

    // Reading another entry still works.
    fireEvent.click(within(entriesNav()).getByRole("button", { name: "Chipset identification" }));
    expect(await screen.findByText("Realtek RTL8812AU")).toBeTruthy();

    // Typing at the view does nothing, and only reads ever reach the API.
    fireEvent.keyDown(screen.getByLabelText("Content of Chipset identification"), { key: "a" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
    expect(calls).toContain(`GET ${BASE}/entries/e2`);
    // And no local draft is written.
    expect(Object.keys(localStorage).filter((k) => k.includes("reNotebook.draft"))).toEqual([]);
  });

  it("an empty notebook offers nothing to create", async () => {
    routes[`GET ${BASE}`] = () => ({ notebook: notebook([]) });
    renderWorkspace({ device: viewerDevice, scope: viewerScope });
    expect(await screen.findByText("This RE Notebook is empty")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create the first section" })).toBeNull();
  });

  it("an empty section offers no new entry", async () => {
    routes[`GET ${BASE}`] = () => ({ notebook: notebook([section("s2", "Firmware Analysis", [])]) });
    renderWorkspace({ device: viewerDevice, scope: viewerScope });
    expect(await screen.findByText("No entries in Firmware Analysis yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New entry|Add an entry/ })).toBeNull();
  });

  it("a member of the same workspace still gets the editor", async () => {
    withEntries();
    renderWorkspace({ device: { ...viewerDevice, role: "member" } as Device, scope: { ...viewerScope, role: "member" } });
    expect(await screen.findByRole("textbox", { name: "Content of Opening the device" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Entry actions" })).toBeTruthy();
  });
});
