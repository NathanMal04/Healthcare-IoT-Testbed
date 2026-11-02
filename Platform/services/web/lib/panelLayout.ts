// Resizable panels (master-detail views, context panels): width limits,
// keyboard resizing, and the width remembered per user and view on this
// browser. Only layout is stored (never content or credentials); anything
// unreadable falls back to the default, and blocked storage just means
// nothing is remembered.
//
// The RE Notebook keeps its own equivalent (reNotebookLayout.ts) for now.

const PREFIX = "vzoniq.layout.v1.";

export interface PanelLimits {
  min: number;
  max: number;
  initial: number;
}

/** Keyboard steps for resizing (arrow keys; Shift for larger steps). */
export const PANEL_STEP = 16;
export const PANEL_STEP_LARGE = 64;

export function clampPanelWidth(limits: PanelLimits, width: number): number {
  if (!Number.isFinite(width)) return limits.initial;
  return Math.round(Math.min(limits.max, Math.max(limits.min, width)));
}

/**
 * The widest a panel may be in a container of `containerWidth`, leaving
 * `minRest` for the content beside it. Never below the panel's minimum.
 */
export function panelMaxWidth(limits: PanelLimits, containerWidth: number, minRest: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return limits.max;
  return Math.max(limits.min, Math.min(limits.max, Math.floor(containerWidth - minRest)));
}

/**
 * The width after a key press on a resize handle, or null for other keys.
 * `grows` is the arrow key that widens the panel: ArrowRight for a panel on
 * the left, ArrowLeft for one on the right.
 */
export function resizeByKey(
  limits: PanelLimits,
  width: number,
  key: string,
  shift: boolean,
  grows: "ArrowLeft" | "ArrowRight",
  max: number = limits.max
): number | null {
  const step = shift ? PANEL_STEP_LARGE : PANEL_STEP;
  const shrinks = grows === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
  let next: number;
  if (key === grows) next = width + step;
  else if (key === shrinks) next = width - step;
  else if (key === "Home") next = limits.min;
  else if (key === "End") next = max;
  else return null;
  return Math.min(max, clampPanelWidth(limits, next));
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Storage keys are per user and per view (e.g. "vulnerabilities.detail"). */
const key = (userId: string, view: string) => `${PREFIX}${userId}.${view}`;

export interface StoredPanel {
  width: number;
  collapsed: boolean;
}

export function readPanel(userId: string, view: string, limits: PanelLimits): StoredPanel {
  const fallback = { width: limits.initial, collapsed: false };
  try {
    const raw = storage()?.getItem(key(userId, view));
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<Record<keyof StoredPanel, unknown>>;
    if (!value || typeof value !== "object") return fallback;
    return {
      width: typeof value.width === "number" ? clampPanelWidth(limits, value.width) : limits.initial,
      collapsed: value.collapsed === true,
    };
  } catch {
    return fallback;
  }
}

export function writePanel(userId: string, view: string, limits: PanelLimits, panel: StoredPanel): void {
  try {
    storage()?.setItem(
      key(userId, view),
      JSON.stringify({ width: clampPanelWidth(limits, panel.width), collapsed: panel.collapsed === true })
    );
  } catch {
    // Not remembered; the layout still works for this visit.
  }
}
