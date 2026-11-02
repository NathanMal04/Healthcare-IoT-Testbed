"use client";

import { useRef } from "react";
import { clampPanelWidth, resizeByKey, type PanelLimits } from "@/lib/panelLayout";

/**
 * The handle between a resizable panel and the content beside it: drag it,
 * or focus it and use the arrow keys (Shift for larger steps), Home and End.
 * Double-click restores the default width. `onResize`'s `remember` is true
 * when a drag or key press ends (the moment to store the width).
 */
export function ResizeHandle({
  label,
  controls,
  limits,
  width,
  max = limits.max,
  panelSide,
  onResize,
}: {
  label: string;
  /** The id of the panel it resizes. */
  controls: string;
  limits: PanelLimits;
  width: number;
  /** The widest the panel may be right now (window size permitting). */
  max?: number;
  /** Which side of the handle the panel is on. */
  panelSide: "left" | "right";
  onResize: (width: number, remember: boolean) => void;
}) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const fit = (value: number) => Math.min(max, clampPanelWidth(limits, value));
  const grows = panelSide === "left" ? "ArrowRight" : "ArrowLeft";

  function end() {
    const start = drag.current;
    drag.current = null;
    if (start) onResize(start.last, true);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={limits.min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title={`${label} (drag, or use the arrow keys)`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, width, last: width };
      }}
      onPointerMove={(e) => {
        const start = drag.current;
        if (!start) return;
        const delta = e.clientX - start.x;
        const next = fit(panelSide === "left" ? start.width + delta : start.width - delta);
        if (next !== start.last) {
          start.last = next;
          onResize(next, false);
        }
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        end();
      }}
      onPointerCancel={end}
      onDoubleClick={() => onResize(fit(limits.initial), true)}
      onKeyDown={(e) => {
        const next = resizeByKey(limits, width, e.key, e.shiftKey, grows, max);
        if (next === null) return;
        e.preventDefault();
        onResize(next, true);
      }}
      className="group relative w-3 shrink-0 cursor-col-resize touch-none select-none outline-none flex justify-center"
    >
      <span
        aria-hidden="true"
        className="my-3 w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-line-strong group-focus-visible:bg-brand-500 group-active:bg-brand-500"
      />
    </div>
  );
}
