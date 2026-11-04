// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@/context/WorkspaceContext", () => ({ useScopeLock: () => undefined }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { userId: "user-1", username: "u" }, loading: false }) }));
// The real menu reads the signed-in user's attributes from Cognito.
vi.mock("@/app/components/shell/UserMenu", () => ({ default: () => <span>user menu</span> }));

import { ApiError, apiRequest } from "@/lib/api";
import type { Artifact } from "@/lib/artifacts";
import type { Device } from "@/lib/devices";
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
