// RE Notebook workspace layout: panel widths and which panels are collapsed,
// remembered per user on this browser. Only layout is stored here (never
// notebook content or credentials); anything unreadable falls back to the
// defaults, and blocked storage simply means nothing is remembered.

const PREFIX = "vzoniq.reNotebook.layout.v1.";

export type PanelSide = "left" | "right";

export const PANEL_LIMITS: Record<PanelSide, { min: number; max: number; initial: number }> = {
  // The entries list.
  left: { min: 220, max: 420, initial: 288 },
  // Device images and artifacts.
  right: { min: 260, max: 480, initial: 320 },
};

/** The editor keeps at least this much width when panels are resized. */
export const MIN_DOCUMENT_WIDTH = 440;

/** Keyboard step for resizing (arrow keys); Shift makes it larger. */
export const RESIZE_STEP = 16;
export const RESIZE_STEP_LARGE = 64;

export interface NotebookLayout {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export const DEFAULT_LAYOUT: NotebookLayout = {
  leftWidth: PANEL_LIMITS.left.initial,
  rightWidth: PANEL_LIMITS.right.initial,
  leftCollapsed: false,
  rightCollapsed: false,
};

export function clampWidth(side: PanelSide, width: number): number {
  const { min, max, initial } = PANEL_LIMITS[side];
  if (!Number.isFinite(width)) return initial;
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * The widest a panel may be right now: its own maximum, or less when the
 * window is too narrow to keep MIN_DOCUMENT_WIDTH for the editor next to the
 * other panel. Never below the panel's minimum.
 */
export function maxWidthFor(side: PanelSide, containerWidth: number, otherPanelWidth: number): number {
  const { min, max } = PANEL_LIMITS[side];
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return max;
  return Math.max(min, Math.min(max, Math.floor(containerWidth - otherPanelWidth - MIN_DOCUMENT_WIDTH)));
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

const layoutKey = (userId: string) => `${PREFIX}${userId}`;

export function readLayout(userId: string): NotebookLayout {
  try {
    const raw = storage()?.getItem(layoutKey(userId));
    if (!raw) return DEFAULT_LAYOUT;
    const value = JSON.parse(raw) as Partial<Record<keyof NotebookLayout, unknown>>;
    if (!value || typeof value !== "object") return DEFAULT_LAYOUT;
    return {
      leftWidth: typeof value.leftWidth === "number" ? clampWidth("left", value.leftWidth) : DEFAULT_LAYOUT.leftWidth,
      rightWidth: typeof value.rightWidth === "number" ? clampWidth("right", value.rightWidth) : DEFAULT_LAYOUT.rightWidth,
      leftCollapsed: value.leftCollapsed === true,
      rightCollapsed: value.rightCollapsed === true,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function writeLayout(userId: string, layout: NotebookLayout): void {
  try {
    storage()?.setItem(
      layoutKey(userId),
      JSON.stringify({
        leftWidth: clampWidth("left", layout.leftWidth),
        rightWidth: clampWidth("right", layout.rightWidth),
        leftCollapsed: layout.leftCollapsed,
        rightCollapsed: layout.rightCollapsed,
      })
    );
  } catch {
    // Not remembered; the layout still works for this visit.
  }
}

/** The width after a resize key, or null for a key that doesn't resize. */
export function keyboardResize(
  side: PanelSide,
  width: number,
  key: string,
  shift: boolean,
  max: number = PANEL_LIMITS[side].max
): number | null {
  const step = shift ? RESIZE_STEP_LARGE : RESIZE_STEP;
  // The left panel grows to the right; the right panel grows to the left.
  const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
  const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
  const { min } = PANEL_LIMITS[side];
  let next: number;
  if (key === grow) next = width + step;
  else if (key === shrink) next = width - step;
  else if (key === "Home") next = min;
  else if (key === "End") next = max;
  else return null;
  return Math.min(max, clampWidth(side, next));
}
