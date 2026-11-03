// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: router.push }),
}));

import { NavigationGuard } from "./NavigationGuard";

const TITLE = "Leave while work is in progress?";

function Page({ active, staysOnPage }: { active: boolean; staysOnPage?: (url: URL) => boolean }) {
  return (
    <div>
      <a href="/devices">Devices</a>
      <a href="/devices/view?id=d&tab=images">Images section</a>
      <a href="/devices/view?id=d&tab=firmware">Firmware</a>
      <a href="/devices/view?id=d&tab=artifacts#list">Same page, other spot</a>
      <a href="/devices" target="_blank">New tab</a>
      <a href="/files/report.pdf" download>
        Download
      </a>
      <a href="https://example.com/">Elsewhere</a>
      <NavigationGuard active={active} staysOnPage={staysOnPage} message="An upload is running." />
    </div>
  );
}

beforeEach(() => {
  router.push.mockReset();
  window.history.replaceState(null, "", "/devices/view?id=d&tab=artifacts");
});
afterEach(cleanup);

const click = (name: string, init: MouseEventInit = {}) => fireEvent.click(screen.getByText(name), init);

describe("NavigationGuard", () => {
  it("does nothing while inactive", () => {
    render(<Page active={false} />);
    click("Devices");
    expect(screen.queryByRole("dialog")).toBeNull();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it("holds an in-app link until the user chooses, then follows it", () => {
    render(<Page active />);
    expect(click("Devices")).toBe(false);
    expect(screen.getByRole("dialog", { name: TITLE })).toBeTruthy();
    expect(screen.getByText("An upload is running.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(router.push).not.toHaveBeenCalled();

    click("Firmware");
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    expect(router.push).toHaveBeenCalledWith("/devices/view?id=d&tab=firmware");
  });

  it("closes on Escape, staying put", () => {
    render(<Page active />);
    click("Devices");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("leaves alone links that don't leave the page: new tabs, downloads, modified clicks, the same page", () => {
    render(<Page active />);
    click("New tab");
    click("Download");
    click("Devices", { ctrlKey: true });
    click("Devices", { metaKey: true });
    click("Devices", { shiftKey: true });
    click("Same page, other spot");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves other sites to the browser's own prompt", () => {
    render(<Page active />);
    click("Elsewhere");
    expect(screen.queryByRole("dialog")).toBeNull();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it("lets links that stay on the page through", () => {
    const staysOnPage = vi.fn((url: URL) => url.pathname === "/devices/view");
    render(<Page active staysOnPage={staysOnPage} />);
    expect(click("Images section")).toBe(true);
    expect(staysOnPage).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    click("Devices");
    expect(screen.getByRole("dialog", { name: TITLE })).toBeTruthy();
  });

  it("leaves browser Back and Forward and the history alone, active or not", () => {
    const pushState = vi.spyOn(window.history, "pushState");
    const go = vi.spyOn(window.history, "go");
    const router = vi.fn();
    // Stands in for the app router's own popstate handler.
    window.addEventListener("popstate", router);
    render(<Page active />);
    for (const path of ["/devices", "/devices/view?id=d&tab=firmware", "/dashboard"]) {
      window.history.replaceState(null, "", path);
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
    }
    expect(router).toHaveBeenCalledTimes(3);
    expect(pushState).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    window.removeEventListener("popstate", router);
    pushState.mockRestore();
    go.mockRestore();
  });

  it("asks again each time a held link is clicked after Cancel", () => {
    render(<Page active />);
    for (let i = 0; i < 3; i++) {
      click("Devices");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    }
    expect(router.push).not.toHaveBeenCalled();
    click("Devices");
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("stops guarding once the work finishes", () => {
    const { rerender } = render(<Page active />);
    rerender(<Page active={false} />);
    click("Devices");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
