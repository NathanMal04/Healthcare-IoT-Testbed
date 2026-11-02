"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "./useFocusTrap";

const WIDTHS = {
  sm: "w-[min(22rem,90vw)]",
  md: "w-[min(28rem,92vw)]",
  lg: "w-[min(40rem,96vw)]",
} as const;

/**
 * A panel that slides over the page from one side: a context panel or a
 * record's details on screens too narrow to show them beside the content,
 * or a secondary task (filters, an uploader). Modal while open: named by its
 * title, keeps keyboard focus inside, closes with Escape, its close button
 * or the backdrop, and returns focus to where it was.
 */
export function Sheet({
  title,
  description,
  side = "right",
  size = "md",
  onClose,
  actions,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  side?: "left" | "right";
  size?: keyof typeof WIDTHS;
  onClose: () => void;
  /** Controls beside the title (before the close button). */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panelRef);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog or menu opened from the sheet closes first.
      const target = e.target as HTMLElement | null;
      const inner = target?.closest?.('[role="dialog"], [role="menu"]');
      if (inner && inner !== panelRef.current) return;
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-navy-950/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={`absolute inset-y-0 ${side === "left" ? "left-0 border-r" : "right-0 border-l"} ${
          WIDTHS[size]
        } flex flex-col bg-white border-line shadow-pop outline-none`}
      >
        <div className="flex items-start gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-section text-slate-900 break-words">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-0.5 text-meta text-slate-500">
                {description}
              </p>
            )}
          </div>
          {actions}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg text-slate-500 hover:bg-surface-sunken hover:text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
