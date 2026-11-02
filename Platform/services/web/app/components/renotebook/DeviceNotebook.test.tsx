// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

import { ApiError, apiRequest } from "@/lib/api";
import type { Device } from "@/lib/devices";
import type { Notebook, NotebookEntry, NotebookSection } from "@/lib/reNotebook";
import type { NotebookDoc } from "@/lib/reNotebookDoc";
import DeviceNotebook from "./DeviceNotebook";
import ConflictDialog from "./ConflictDialog";

const request = vi.mocked(apiRequest);
const D = "11111111-1111-4111-8111-000000000001";
const device = { deviceId: D, name: "Alfa AWUS036ACH", type: "wifi", role: "owner" } as Device;
const BASE = `/devices/${D}/notebook`;

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

beforeEach(() => {
  routes = {};
  request.mockReset();
  request.mockImplementation(async (method, path, options) => {
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(options?.body, options?.query) as never;
  });
});
afterEach(cleanup);

function openMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  const menus = screen.getAllByRole("menu");
  return menus[menus.length - 1];
}

describe("DeviceNotebook", () => {
  it("starts an empty notebook with its first section", async () => {
    routes[`GET ${BASE}`] = () => ({ notebook: notebook([]) });
    routes[`POST ${BASE}/sections`] = (body) => {
      expect(body).toEqual({ title: "Physical Teardown" });
      return { sectionId: "s1", notebook: notebook([section("s1", "Physical Teardown", [])]) };
    };
    render(<DeviceNotebook device={device} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create the first section" }));
    fireEvent.change(screen.getByLabelText("Section title"), { target: { value: "  Physical Teardown " } });
    fireEvent.click(screen.getByRole("button", { name: "Create section" }));
    expect(await screen.findByRole("heading", { name: /Physical Teardown/ })).toBeTruthy();
    expect(screen.getByText(/No entries yet\./)).toBeTruthy();
  });

  it("lists sections and entries in order and opens the linked entry", async () => {
    routes[`GET ${BASE}`] = () => ({ notebook: full() });
    routes[`GET ${BASE}/entries/e2`] = () => ({ entry: full().sections[0].entries[1], doc: paragraph("Realtek RTL8812AU") });
    const onEntryChange = vi.fn();
    render(<DeviceNotebook device={device} initialEntryId="e2" onEntryChange={onEntryChange} />);
    const nav = await screen.findByRole("navigation", { name: "Notebook sections and entries" });
    const entries = within(nav).getAllByRole("button", { name: /^(Opening the device|Chipset identification)$/ });
    expect(entries.map((b) => b.textContent)).toEqual(["Opening the device", "Chipset identification"]);
    expect(within(nav).getByRole("button", { name: "Chipset identification" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("heading", { name: "Chipset identification", level: 2 })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Realtek RTL8812AU")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toMatch(/Saved/);
    expect(onEntryChange).not.toHaveBeenCalled();
  });

  it("opens the first entry when no entry is linked", async () => {
    routes[`GET ${BASE}`] = () => ({ notebook: full() });
    routes[`GET ${BASE}/entries/e1`] = () => ({ entry: full().sections[0].entries[0], doc: paragraph("four screws") });
    const onEntryChange = vi.fn();
    render(<DeviceNotebook device={device} onEntryChange={onEntryChange} />);
    expect(await screen.findByText("four screws")).toBeTruthy();
    expect(onEntryChange).toHaveBeenCalledWith("e1");
  });

  it("only offers deleting a section once it is empty", async () => {
    routes[`GET ${BASE}`] = () => ({ notebook: full() });
    routes[`GET ${BASE}/entries/e1`] = () => ({ entry: full().sections[0].entries[0], doc: paragraph("x") });
    render(<DeviceNotebook device={device} />);
    await screen.findByText("x");
    let menu = openMenu("Actions for section Physical Teardown");
    expect((within(menu).getByRole("menuitem", { name: /Delete section/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Actions for section Physical Teardown" }));
    menu = openMenu("Actions for section Firmware Analysis");
    expect((within(menu).getByRole("menuitem", { name: "Delete section" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("moves an entry down with the version it was based on", async () => {
    routes[`GET ${BASE}`] = () => ({ notebook: full() });
    routes[`GET ${BASE}/entries/e1`] = () => ({ entry: full().sections[0].entries[0], doc: paragraph("x") });
    const reordered = full();
    reordered.sections[0].entries.reverse();
    routes[`PUT ${BASE}/sections/s1/entry-order`] = (body) => {
      expect(body).toEqual({ entryIds: ["e2", "e1"], expectedOrderVersion: 2 });
      return { notebook: reordered };
    };
    render(<DeviceNotebook device={device} />);
    await screen.findByText("x");
    fireEvent.click(within(openMenu("Actions for entry Opening the device")).getByRole("menuitem", { name: "Move down" }));
    const nav = screen.getByRole("navigation", { name: "Notebook sections and entries" });
    await waitFor(() =>
      expect(within(nav).getAllByRole("button", { name: /^(Opening the device|Chipset identification)$/ }).map((b) => b.textContent)).toEqual([
        "Chipset identification",
        "Opening the device",
      ])
    );
  });

  it("explains a change refused because someone else changed the notebook, and shows theirs", async () => {
    routes[`GET ${BASE}`] = () => ({ notebook: full() });
    routes[`GET ${BASE}/entries/e1`] = () => ({ entry: full().sections[0].entries[0], doc: paragraph("x") });
    const theirs = full();
    theirs.sections[0].entries.push(entry("e9", "s1", "Added by a colleague"));
    routes[`PUT ${BASE}/sections/s1/entry-order`] = () => {
      throw new ApiError("The section was changed by someone else", 409, { code: "stale_order", notebook: theirs });
    };
    render(<DeviceNotebook device={device} />);
    await screen.findByText("x");
    fireEvent.click(within(openMenu("Actions for entry Opening the device")).getByRole("menuitem", { name: "Move down" }));
    expect(await screen.findByText(/someone else changed the notebook at the same time/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Added by a colleague" })).toBeTruthy();
  });

  it("deletes an entry after confirming, with the versions it last saw", async () => {
    routes[`GET ${BASE}`] = () => ({ notebook: full() });
    routes[`GET ${BASE}/entries/e1`] = () => ({ entry: full().sections[0].entries[0], doc: paragraph("x") });
    const after = full();
    after.sections[0].entries.splice(1, 1);
    routes[`DELETE ${BASE}/entries/e2`] = (_body, query) => {
      expect(query).toEqual({ expectedVersion: 1, expectedContentVersion: 1 });
      return { notebook: after };
    };
    render(<DeviceNotebook device={device} />);
    await screen.findByText("x");
    fireEvent.click(within(openMenu("Actions for entry Chipset identification")).getByRole("menuitem", { name: "Delete entry" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/kept in the database/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete entry" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Chipset identification" })).toBeNull());
  });

  it("shows why the notebook couldn't load, with a retry", async () => {
    let calls = 0;
    routes[`GET ${BASE}`] = () => {
      calls += 1;
      if (calls === 1) throw new ApiError("Device not found", 404);
      return { notebook: notebook([]) };
    };
    render(<DeviceNotebook device={device} />);
    expect(await screen.findByText("Device not found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Create the first section" })).toBeTruthy();
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
