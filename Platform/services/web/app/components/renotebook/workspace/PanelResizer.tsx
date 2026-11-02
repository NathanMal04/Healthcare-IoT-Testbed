"use client";

import { useRef } from "react";
import { PANEL_LIMITS, clampWidth, keyboardResize, type PanelSide } from "@/lib/reNotebookLayout";

/**
 * The handle between a side panel and the editor: drag it, or focus it and
 * use the arrow keys (Shift for larger steps), Home and End. Double-click
 * restores the default width. The width is remembered when a drag or key
 * press ends.
 */
export default function PanelResizer({
  side,
  label,
  width,
  max,
  controls,
  onResize,
}: {
  side: PanelSide;
  label: string;
  width: number;
  /** The widest the panel may be now (window size permitting). */
  max: number;
  /** The id of the panel it resizes. */
  controls: string;
  onResize: (width: number, remember: boolean) => void;
}) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const { min } = PANEL_LIMITS[side];
  const fit = (value: number) => Math.min(max, clampWidth(side, value));

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
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
        const next = fit(side === "left" ? start.width + delta : start.width - delta);
        if (next !== start.last) {
          start.last = next;
          onResize(next, false);
        }
      }}
      onPointerUp={(e) => {
        const start = drag.current;
        drag.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        if (start) onResize(start.last, true);
      }}
      onPointerCancel={() => {
        const start = drag.current;
        drag.current = null;
        if (start) onResize(start.last, true);
      }}
      onDoubleClick={() => onResize(fit(PANEL_LIMITS[side].initial), true)}
      onKeyDown={(e) => {
        const next = keyboardResize(side, width, e.key, e.shiftKey, max);
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
