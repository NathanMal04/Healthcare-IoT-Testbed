// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clampPanelWidth, panelMaxWidth, readPanel, resizeByKey, writePanel, type PanelLimits } from "./panelLayout";

const LIMITS: PanelLimits = { min: 300, max: 700, initial: 480 };

beforeEach(() => localStorage.clear());

describe("panel widths", () => {
  it("stay within the limits", () => {
    expect(clampPanelWidth(LIMITS, 10)).toBe(300);
    expect(clampPanelWidth(LIMITS, 9000)).toBe(700);
    expect(clampPanelWidth(LIMITS, 512.6)).toBe(513);
    expect(clampPanelWidth(LIMITS, Number.NaN)).toBe(480);
  });

  it("leave room for the content beside the panel", () => {
    expect(panelMaxWidth(LIMITS, 2000, 420)).toBe(700);
    expect(panelMaxWidth(LIMITS, 1000, 420)).toBe(580);
    expect(panelMaxWidth(LIMITS, 600, 420)).toBe(300); // never below the minimum
    expect(panelMaxWidth(LIMITS, 0, 420)).toBe(700); // not measured yet
  });

  it("change by key, in the direction that grows the panel", () => {
    // A panel on the right grows with ArrowLeft.
    expect(resizeByKey(LIMITS, 480, "ArrowLeft", false, "ArrowLeft")).toBe(496);
    expect(resizeByKey(LIMITS, 480, "ArrowRight", true, "ArrowLeft")).toBe(416);
    // A panel on the left grows with ArrowRight.
    expect(resizeByKey(LIMITS, 480, "ArrowRight", false, "ArrowRight")).toBe(496);
    expect(resizeByKey(LIMITS, 480, "Home", false, "ArrowRight")).toBe(300);
    expect(resizeByKey(LIMITS, 480, "End", false, "ArrowRight", 600)).toBe(600);
    expect(resizeByKey(LIMITS, 480, "Enter", false, "ArrowRight")).toBeNull();
  });
});

describe("remembered panels", () => {
  it("are kept per user and view", () => {
    writePanel("user-a", "cves.detail", LIMITS, { width: 600, collapsed: true });
    expect(readPanel("user-a", "cves.detail", LIMITS)).toEqual({ width: 600, collapsed: true });
    expect(readPanel("user-b", "cves.detail", LIMITS)).toEqual({ width: 480, collapsed: false });
    expect(readPanel("user-a", "runs.detail", LIMITS)).toEqual({ width: 480, collapsed: false });
  });

  it("fall back to the defaults for anything unreadable, and store only layout", () => {
    localStorage.setItem("vzoniq.layout.v1.user-a.cves.detail", "{oops");
    expect(readPanel("user-a", "cves.detail", LIMITS)).toEqual({ width: 480, collapsed: false });
    localStorage.setItem("vzoniq.layout.v1.user-a.cves.detail", JSON.stringify({ width: 99999, collapsed: "yes" }));
    expect(readPanel("user-a", "cves.detail", LIMITS)).toEqual({ width: 700, collapsed: false });
    writePanel("user-a", "cves.detail", LIMITS, { width: 500, collapsed: false, extra: 1 } as never);
    expect(Object.keys(JSON.parse(localStorage.getItem("vzoniq.layout.v1.user-a.cves.detail")!)).sort()).toEqual([
      "collapsed",
      "width",
    ]);
  });
});
