// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

const nav = vi.hoisted(() => ({ pathname: "/devices", push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { userId: "user-1", username: "u" }, loading: false }),
}));
// The real account menu reads the user's attributes from Cognito; its sign-out
// guard has its own tests. Here it only has to be reachable.
vi.mock("./UserMenu", () => ({
  default: () => (
    <button type="button" aria-label="Account menu">
      IP
    </button>
  ),
}));

const workspace = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));
vi.mock("@/context/WorkspaceContext", () => ({
  useWorkspace: () => workspace.state,
  useScopeLock: () => undefined,
}));

import AppShell from "./AppShell";
import { usePageCrumbs } from "./ShellContext";
import { axeViolations } from "@/app/components/ui/testing/axe";

const LAB = { workspaceId: "ws-1", name: "Cardiac Lab", role: "owner" };

function resetWorkspace(patch: Record<string, unknown> = {}) {
  workspace.state = {
    scope: { kind: "personal" },
    scopeReady: true,
    workspaces: [LAB],
    workspacesError: null,
    selectPersonal: vi.fn(),
    selectWorkspace: vi.fn(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    panel: null,
    notice: null,
    dismissNotice: vi.fn(),
    invitations: [{ invitationId: "i1" }],
    scopeLocked: false,
    ...patch,
  };
}

beforeEach(() => {
  localStorage.clear();
  nav.pathname = "/devices";
  resetWorkspace();
});
afterEach(cleanup);

function renderShell(children: React.ReactNode = <h1>Devices</h1>) {
  return render(<AppShell>{children}</AppShell>);
}

const desktopNav = () => document.getElementById("app-navigation")!;

describe("AppShell navigation", () => {
  it("lists the groups and pages, marks the current one, and keeps every URL", () => {
    renderShell();
    const main = within(desktopNav()).getByRole("navigation", { name: "Main" });
    expect(within(main).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Research", "Analysis", "System"]);
    const links = within(main).getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")]);
    expect(links).toEqual([
      ["Dashboard", "/dashboard"],
      ["Devices", "/devices"],
      ["Firmware", "/firmware"],
      ["Artifacts", "/artifacts"],
      ["Vulnerabilities", "/vulnerabilities"],
      ["Scripts", "/scripts"],
      ["Environments", "/environments"],
      ["Runs", "/runs"],
      ["Analysis Notebooks", "/notebooks"],
      ["Workspaces", "/workspaces"],
      ["Usage", "/usage"],
    ]);
    expect(within(main).getByRole("link", { name: "Devices" }).getAttribute("aria-current")).toBe("page");
    expect(within(main).getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
  });

  it("keeps invitations and the account menu in the top bar", () => {
    renderShell();
    const banner = within(screen.getByRole("banner"));
    fireEvent.click(banner.getByRole("button", { name: "Invitations (1 pending)" }));
    expect(workspace.state.openPanel).toHaveBeenCalledWith("invitations");
    expect(banner.getByRole("button", { name: "Account menu" })).toBeTruthy();
  });

  it("collapses to an icon rail with accessible names, and remembers it for this user", () => {
    const { unmount } = renderShell();
    const toggle = within(desktopNav()).getByRole("button", { name: "Collapse navigation" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(desktopNav().className).toContain("w-60");
    fireEvent.click(toggle);
    expect(desktopNav().className).toContain("w-16");
    const expand = within(desktopNav()).getByRole("button", { name: "Expand navigation" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    // Icons only, but every link keeps its name (and a tooltip).
    const main = within(desktopNav()).getByRole("navigation", { name: "Main" });
    expect(within(main).getByRole("link", { name: "Analysis Notebooks" }).getAttribute("href")).toBe("/notebooks");
    expect(JSON.parse(localStorage.getItem("vzoniq.shell.v1.user-1")!)).toEqual({ sidebarCollapsed: true });

    unmount();
    renderShell();
    expect(desktopNav().className).toContain("w-16");
    // The rail's scope button expands the navigation to switch scope.
    fireEvent.click(within(desktopNav()).getByRole("button", { name: /^Scope: Personal/ }));
    expect(desktopNav().className).toContain("w-60");
    expect(within(desktopNav()).getByRole("combobox", { name: "Personal or workspace" })).toBeTruthy();
  });

  it("keeps every page reachable in the rail at short heights, with tooltips the scrolling list can't clip", () => {
    localStorage.setItem("vzoniq.shell.v1.user-1", JSON.stringify({ sidebarCollapsed: true }));
    renderShell();
    const main = within(desktopNav()).getByRole("navigation", { name: "Main" });
    // The list scrolls (rather than overflowing) when the window is short.
    expect(main.className).toContain("overflow-y-auto");
    expect(main.className).toContain("min-h-0");
    expect(within(main).getAllByRole("link")).toHaveLength(11);

    const usage = within(main).getByRole("link", { name: "Usage" });
    expect(usage.querySelector("[data-rail-tooltip]")).toBeNull();
    fireEvent.mouseEnter(usage);
    const tip = usage.querySelector<HTMLElement>("[data-rail-tooltip]")!;
    expect(tip.textContent).toBe("Usage");
    expect(tip.className).toContain("fixed"); // placed against the window, outside the list's clipping
    expect(tip.getAttribute("aria-hidden")).toBe("true"); // the link is already named
    fireEvent.mouseLeave(usage);
    expect(usage.querySelector("[data-rail-tooltip]")).toBeNull();

    // Keyboard focus shows it too.
    fireEvent.focus(usage);
    expect(usage.querySelector("[data-rail-tooltip]")).toBeTruthy();
    fireEvent.blur(usage);
    expect(usage.querySelector("[data-rail-tooltip]")).toBeNull();
  });

  it("passes automated accessibility checks, expanded and collapsed", async () => {
    const { container } = renderShell();
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(desktopNav()).getByRole("button", { name: "Collapse navigation" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("AppShell scope selector", () => {
  it("switches workspace through the workspace context", () => {
    renderShell();
    const select = within(desktopNav()).getByRole("combobox", { name: "Personal or workspace" });
    fireEvent.change(select, { target: { value: "workspace:ws-1" } });
    expect(workspace.state.selectWorkspace).toHaveBeenCalledWith(LAB);
    fireEvent.change(select, { target: { value: "__create__" } });
    expect(workspace.state.openPanel).toHaveBeenCalledWith("create");
  });

  it("can't switch while a scope lock (an upload or unsaved change) holds", () => {
    resetWorkspace({ scopeLocked: true });
    renderShell();
    const select = within(desktopNav()).getByRole("combobox", { name: "Personal or workspace" }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.getAttribute("aria-describedby")).toBe("scope-locked-reason");
    expect(screen.getByText(/Finish the upload or change in progress/)).toBeTruthy();
  });

  it("offers the members of a selected workspace", () => {
    resetWorkspace({ scope: { kind: "workspace", workspaceId: "ws-1", name: "Cardiac Lab", role: "owner" } });
    renderShell();
    fireEvent.click(within(desktopNav()).getByRole("button", { name: "Members" }));
    expect(workspace.state.openPanel).toHaveBeenCalledWith("members");
  });
});

describe("AppShell mobile drawer", () => {
  it("opens as a modal that keeps focus inside, and closes with Escape back to the menu button", async () => {
    renderShell();
    const menu = screen.getByRole("button", { name: "Open navigation" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    menu.focus();
    fireEvent.click(menu);
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(within(drawer).getByRole("link", { name: "Analysis Notebooks" })).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: "Collapse navigation" })).toBeNull();

    const focusable = [...drawer.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), select:not([disabled])")];
    focusable[focusable.length - 1].focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);

    expect(await axeViolations(drawer)).toEqual([]);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it("closes when a page is chosen, or a workspace dialog opens", () => {
    const { rerender } = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Navigation" })).getByRole("link", { name: "Runs" }));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeTruthy();
    workspace.state = { ...workspace.state, panel: "create" };
    rerender(
      <AppShell>
        <h1>Devices</h1>
      </AppShell>
    );
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });

  it("closes with its close button and the backdrop", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Navigation" })).getByRole("button", { name: "Close navigation" }));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });
});

describe("AppShell breadcrumbs", () => {
  const crumbs = () => within(screen.getByRole("navigation", { name: "Breadcrumb" }));

  it("show the current page", () => {
    renderShell();
    const current = crumbs().getAllByText("Devices").find((el) => el.getAttribute("aria-current") === "page");
    expect(current).toBeTruthy();
  });

  it("link a detail page back to its list, and name the record once the page knows it", () => {
    nav.pathname = "/devices/view";
    function DevicePage() {
      const [name, setName] = useState<string | null>(null);
      usePageCrumbs(name ? [{ label: "Devices", href: "/devices" }, { label: name }] : null);
      return (
        <button type="button" onClick={() => setName("Acme Cam 1000")}>
          Load
        </button>
      );
    }
    const { rerender } = renderShell(<DevicePage />);
    // The parent shows twice: the full trail, and the back link for narrow screens.
    expect(crumbs().getAllByRole("link", { name: /Devices/ }).every((l) => l.getAttribute("href") === "/devices")).toBe(true);
    expect(crumbs().getByRole("link", { name: "Back to Devices" })).toBeTruthy();
    expect(crumbs().getByText("Device").getAttribute("aria-current")).toBe("page");

    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(crumbs().getByText("Acme Cam 1000").getAttribute("aria-current")).toBe("page");

    // Leaving the page drops its trail.
    act(() => {
      rerender(
        <AppShell>
          <p>Other page</p>
        </AppShell>
      );
    });
    expect(crumbs().queryByText("Acme Cam 1000")).toBeNull();
    expect(crumbs().getByText("Device")).toBeTruthy();
  });
});

describe("breadcrumb landmarks", () => {
  // The pages that used to draw their own breadcrumb navigation keep the
  // trail as a visual aid only: the top bar's is the one landmark.
  it("are unique on the pages that also show an in-page trail", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const file of [
      "app/(app)/vulnerabilities/view/page.tsx",
      "app/(app)/devices/view/page.tsx",
      "app/components/workspaces/WorkspaceOverview.tsx",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect([file, source.includes('aria-label="Breadcrumb"')]).toEqual([file, false]);
      expect([file, source.includes('aria-current="page"')]).toEqual([file, false]);
    }
  });

  it("leave the shell with a single breadcrumb navigation", () => {
    nav.pathname = "/devices/view";
    renderShell(<p>Device</p>);
    expect(screen.getAllByRole("navigation", { name: "Breadcrumb" })).toHaveLength(1);
  });
});

describe("AppShell content width", () => {
  const container = () => screen.getByRole("main").firstElementChild!;

  it("is fluid for tables and research workspaces, default for detail and settings pages", () => {
    nav.pathname = "/devices";
    const { unmount } = renderShell();
    expect(container().className).toContain("max-w-content-fluid");
    unmount();
    nav.pathname = "/usage";
    renderShell();
    expect(container().className).toContain("max-w-content-default");
  });
});
