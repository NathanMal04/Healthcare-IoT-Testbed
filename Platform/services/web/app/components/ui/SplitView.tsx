"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { panelMaxWidth, readPanel, writePanel, type PanelLimits } from "@/lib/panelLayout";
import { ResizeHandle } from "./ResizeHandle";
import { Sheet } from "./Sheet";
import { LARGE_SCREEN, useMediaQuery } from "./useMediaQuery";

export const DETAIL_LIMITS: PanelLimits = { min: 360, max: 760, initial: 480 };

/**
 * Master-detail: a list (a table of CVEs, runs, artifacts, …) with the
 * selected record's details beside it on large screens, in a resizable panel
 * whose width is remembered per user and view. On smaller screens the
 * details open as a sheet over the list instead.
 *
 * The list stays mounted while details open, close or change, so its
 * scroll position, filters and selection survive.
 */
export function SplitView({
  view,
  userId,
  list,
  detail,
  detailTitle,
  detailLabel,
  onCloseDetail,
  emptyDetail,
  limits = DETAIL_LIMITS,
  minListWidth = 420,
}: {
  /** Names this layout for the remembered width, e.g. "vulnerabilities.detail". */
  view: string;
  /** The signed-in user; without one the width isn't remembered. */
  userId?: string;
  list: React.ReactNode;
  /** The open record's details, or null when none is open. */
  detail: React.ReactNode | null;
  /** The details' title (the sheet's heading on small screens). */
  detailTitle: React.ReactNode;
  /** The detail panel's accessible name, e.g. "CVE details". */
  detailLabel: string;
  onCloseDetail: () => void;
  /** Shown in the panel on large screens while nothing is open; without it the list uses the full width. */
  emptyDetail?: React.ReactNode;
  limits?: PanelLimits;
  /** The list keeps at least this width when the panel is resized. */
  minListWidth?: number;
}) {
  const large = useMediaQuery(LARGE_SCREEN);
  const [width, setWidth] = useState(() => (userId ? readPanel(userId, view, limits).width : limits.initial));
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panelId = `split-detail-${view.replace(/[^a-z0-9-]/gi, "-")}`;

  useEffect(() => {
    if (userId) setWidth(readPanel(userId, view, limits).width);
  }, [userId, view, limits]);

  useLayoutEffect(() => {
    const measure = () => setContainerWidth(containerRef.current?.clientWidth ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const onResize = useCallback(
    (next: number, remember: boolean) => {
      setWidth(next);
      if (remember && userId) writePanel(userId, view, limits, { width: next, collapsed: false });
    },
    [userId, view, limits]
  );

  const max = panelMaxWidth(limits, containerWidth, minListWidth);
  const shownWidth = Math.min(width, max);
  const panelContent = detail ?? emptyDetail;

  return (
    <div ref={containerRef} className="flex min-w-0 items-stretch">
      <div className="min-w-0 flex-1">{list}</div>
      {large && panelContent != null && (
        <>
          <ResizeHandle
            label={`Resize ${detailLabel.toLowerCase()}`}
            controls={panelId}
            limits={limits}
            width={shownWidth}
            max={max}
            panelSide="right"
            onResize={onResize}
          />
          <aside id={panelId} aria-label={detailLabel} className="shrink-0 min-w-0" style={{ width: shownWidth }}>
            {panelContent}
          </aside>
        </>
      )}
      {!large && detail != null && (
        <Sheet title={detailTitle} onClose={onCloseDetail} size="lg">
          {detail}
        </Sheet>
      )}
    </div>
  );
}
