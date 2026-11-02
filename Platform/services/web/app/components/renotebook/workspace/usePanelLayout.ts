"use client";

import { useCallback, useEffect, useState } from "react";
import { readLayout, writeLayout, type NotebookLayout, type PanelSide } from "@/lib/reNotebookLayout";

export type Viewport = "desktop" | "tablet" | "mobile";

const DESKTOP_QUERY = "(min-width: 1280px)";
const TABLET_QUERY = "(min-width: 768px)";

function currentViewport(): Viewport {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "desktop";
  if (window.matchMedia(DESKTOP_QUERY).matches) return "desktop";
  if (window.matchMedia(TABLET_QUERY).matches) return "tablet";
  return "mobile";
}

/** The viewport class, following window resizes. */
function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(currentViewport);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const queries = [window.matchMedia(DESKTOP_QUERY), window.matchMedia(TABLET_QUERY)];
    const update = () => setViewport(currentViewport());
    queries.forEach((q) => q.addEventListener?.("change", update));
    update();
    return () => queries.forEach((q) => q.removeEventListener?.("change", update));
  }, []);
  return viewport;
}

export interface PanelLayout {
  viewport: Viewport;
  layout: NotebookLayout;
  focus: boolean;
  /** How each panel shows now: beside the editor, over it (a drawer), or not at all. */
  left: "inline" | "drawer" | "hidden";
  right: "inline" | "drawer" | "hidden";
  /** Whether each panel is visible (for the toggles' aria-expanded). */
  leftShown: boolean;
  rightShown: boolean;
  toggle: (side: PanelSide) => void;
  /** Closes a drawer (small screens); collapsed panels stay as they are. */
  closeDrawers: () => void;
  setFocus: (focus: boolean) => void;
  /** Sets a panel's width; `remember` stores it (at the end of a drag). */
  setWidth: (side: PanelSide, width: number, remember: boolean) => void;
}

/**
 * The notebook workspace's panels. On desktop both side panels sit beside the
 * editor, can be resized and collapsed, and are remembered per user. On
 * tablets the context panel opens over the editor; on phones both do. Focus
 * Mode hides both. None of this unmounts the editor: only how the panels are
 * shown changes.
 */
export function usePanelLayout(userId: string | undefined): PanelLayout {
  const viewport = useViewport();
  const [layout, setLayout] = useState<NotebookLayout>(() => readLayout(userId ?? ""));
  const [drawer, setDrawer] = useState<PanelSide | null>(null);
  const [focus, setFocusState] = useState(false);

  useEffect(() => {
    if (userId) setLayout(readLayout(userId));
  }, [userId]);

  // A drawer opened on a small screen doesn't stay open on a larger one.
  useEffect(() => {
    setDrawer(null);
  }, [viewport]);

  const update = useCallback(
    (change: (current: NotebookLayout) => NotebookLayout, remember: boolean) => {
      setLayout((current) => {
        const next = change(current);
        if (remember && userId) writeLayout(userId, next);
        return next;
      });
    },
    [userId]
  );

  const leftInline = viewport !== "mobile";
  const rightInline = viewport === "desktop";
  const left: PanelLayout["left"] = focus
    ? "hidden"
    : leftInline
      ? layout.leftCollapsed ? "hidden" : "inline"
      : drawer === "left" ? "drawer" : "hidden";
  const right: PanelLayout["right"] = focus
    ? "hidden"
    : rightInline
      ? layout.rightCollapsed ? "hidden" : "inline"
      : drawer === "right" ? "drawer" : "hidden";

  const toggle = useCallback(
    (side: PanelSide) => {
      setFocusState(false);
      const inline = side === "left" ? viewport !== "mobile" : viewport === "desktop";
      if (inline) {
        const key = side === "left" ? "leftCollapsed" : "rightCollapsed";
        // Leaving Focus Mode through a panel toggle shows that panel.
        update((current) => ({ ...current, [key]: focus ? false : !current[key] }), true);
        setDrawer(null);
      } else {
        setDrawer((current) => (current === side && !focus ? null : side));
      }
    },
    [viewport, update, focus]
  );

  return {
    viewport,
    layout,
    focus,
    left,
    right,
    leftShown: left !== "hidden",
    rightShown: right !== "hidden",
    toggle,
    closeDrawers: useCallback(() => setDrawer(null), []),
    setFocus: useCallback((value: boolean) => {
      setFocusState(value);
      setDrawer(null);
    }, []),
    setWidth: useCallback(
      (side: PanelSide, width: number, remember: boolean) =>
        update((current) => ({ ...current, [side === "left" ? "leftWidth" : "rightWidth"]: width }), remember),
      [update]
    ),
  };
}
