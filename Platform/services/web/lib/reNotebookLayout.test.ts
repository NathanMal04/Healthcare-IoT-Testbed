// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  MIN_DOCUMENT_WIDTH,
  PANEL_LIMITS,
  clampWidth,
  keyboardResize,
  maxWidthFor,
  readLayout,
  writeLayout,
} from "./reNotebookLayout";

beforeEach(() => localStorage.clear());

describe("panel widths", () => {
  it("stay within each panel's limits", () => {
    expect(clampWidth("left", 10)).toBe(PANEL_LIMITS.left.min);
    expect(clampWidth("left", 9999)).toBe(PANEL_LIMITS.left.max);
    expect(clampWidth("right", 300.4)).toBe(300);
    expect(clampWidth("right", Number.NaN)).toBe(PANEL_LIMITS.right.initial);
  });

  it("leave the editor its minimum width in a narrow window", () => {
    expect(maxWidthFor("left", 3000, 320)).toBe(PANEL_LIMITS.left.max);
    expect(maxWidthFor("left", 1100, 320)).toBe(1100 - 320 - MIN_DOCUMENT_WIDTH);
    // Never below the panel's own minimum.
    expect(maxWidthFor("left", 700, 320)).toBe(PANEL_LIMITS.left.min);
  });

  it("change with the arrow keys, Home and End", () => {
    expect(keyboardResize("left", 288, "ArrowRight", false)).toBe(304);
    expect(keyboardResize("left", 288, "ArrowLeft", true)).toBe(224);
    // The right panel grows towards the left.
    expect(keyboardResize("right", 320, "ArrowLeft", false)).toBe(336);
    expect(keyboardResize("right", 320, "Home", false)).toBe(PANEL_LIMITS.right.min);
    expect(keyboardResize("right", 320, "End", false, 400)).toBe(400);
    expect(keyboardResize("left", 410, "ArrowRight", true)).toBe(PANEL_LIMITS.left.max);
    expect(keyboardResize("left", 288, "Enter", false)).toBeNull();
  });
});

describe("remembered layout", () => {
  it("is kept per user", () => {
    writeLayout("user-a", { leftWidth: 300, rightWidth: 400, leftCollapsed: true, rightCollapsed: false });
    expect(readLayout("user-a")).toEqual({ leftWidth: 300, rightWidth: 400, leftCollapsed: true, rightCollapsed: false });
    expect(readLayout("user-b")).toEqual(DEFAULT_LAYOUT);
  });

  it("falls back to the defaults for anything unreadable", () => {
    localStorage.setItem("vzoniq.reNotebook.layout.v1.user-a", "{not json");
    expect(readLayout("user-a")).toEqual(DEFAULT_LAYOUT);
    localStorage.setItem(
      "vzoniq.reNotebook.layout.v1.user-a",
      JSON.stringify({ leftWidth: 99999, rightWidth: "wide", leftCollapsed: "yes" })
    );
    expect(readLayout("user-a")).toEqual({ ...DEFAULT_LAYOUT, leftWidth: PANEL_LIMITS.left.max });
  });

  it("stores only layout fields", () => {
    writeLayout("user-a", { ...DEFAULT_LAYOUT, extra: "x" } as never);
    const stored = JSON.parse(localStorage.getItem("vzoniq.reNotebook.layout.v1.user-a")!);
    expect(Object.keys(stored).sort()).toEqual(["leftCollapsed", "leftWidth", "rightCollapsed", "rightWidth"]);
  });
});
