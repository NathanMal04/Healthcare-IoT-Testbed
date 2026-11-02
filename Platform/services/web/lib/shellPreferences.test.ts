// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SHELL_PREFERENCES, readShellPreferences, writeShellPreferences } from "./shellPreferences";

beforeEach(() => localStorage.clear());

describe("shell preferences", () => {
  it("remember the sidebar mode per user", () => {
    expect(readShellPreferences("user-a")).toEqual(DEFAULT_SHELL_PREFERENCES);
    writeShellPreferences("user-a", { sidebarCollapsed: true });
    expect(readShellPreferences("user-a")).toEqual({ sidebarCollapsed: true });
    expect(readShellPreferences("user-b")).toEqual({ sidebarCollapsed: false });
  });

  it("fall back to the default for anything unreadable, and store only the flag", () => {
    localStorage.setItem("vzoniq.shell.v1.user-a", "{nope");
    expect(readShellPreferences("user-a")).toEqual(DEFAULT_SHELL_PREFERENCES);
    localStorage.setItem("vzoniq.shell.v1.user-a", JSON.stringify({ sidebarCollapsed: "yes" }));
    expect(readShellPreferences("user-a")).toEqual({ sidebarCollapsed: false });
    writeShellPreferences("user-a", { sidebarCollapsed: true, other: 1 } as never);
    expect(JSON.parse(localStorage.getItem("vzoniq.shell.v1.user-a")!)).toEqual({ sidebarCollapsed: true });
  });
});
