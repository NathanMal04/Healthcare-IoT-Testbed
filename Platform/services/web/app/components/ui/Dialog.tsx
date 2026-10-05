"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { Alert } from "./States";
import { buttonClass } from "./styles";

const DIALOG_WIDTHS = { sm: "sm:max-w-sm", lg: "sm:max-w-lg", xl: "sm:max-w-2xl", "2xl": "sm:max-w-4xl" } as const;

/**
 * A modal with a title and a close button. Clicking the backdrop or pressing
 * Escape calls onClose, which callers guard while work is in progress.
 * `wide` is the same as size "lg".
 */
export function Dialog({
  title,
  subtitle,
  onClose,
  wide,
  size,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  size?: keyof typeof DIALOG_WIDTHS;
  children: React.ReactNode;
}) {
  const width = DIALOG_WIDTHS[size ?? (wide ? "lg" : "sm")];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-navy-950/60 backdrop-blur-[1px] flex items-end sm:items-center justify-center z-50 sm:px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full ${width} bg-white rounded-t-2xl sm:rounded-xl border border-line shadow-pop p-5 sm:p-6 max-h-[90vh] overflow-y-auto`}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-900 tracking-tight break-words">{title}</h2>
            {subtitle && <p className="text-slate-500 text-sm mt-1">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 -mr-1 p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-surface-sunken"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A confirmation step for a destructive or irreversible action. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  busy = false,
  error,
  tone = "danger",
  onConfirm,
  onCancel,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  error?: string | null;
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog title={title} onClose={() => !busy && onCancel()} wide>
      <div className="space-y-4 text-sm text-slate-700">
        {children}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} disabled={busy} className={buttonClass("secondary")}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={buttonClass(tone)}>
            {busy ? busyLabel ?? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Full-screen text viewer for build logs, job logs and package lists. */
export function TextModal({
  title,
  text,
  loading,
  onClose,
}: {
  title: string;
  text: string | null;
  loading?: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose} size="2xl">
      <pre className="text-xs bg-navy-950 text-slate-100 rounded-lg p-4 max-h-[65vh] overflow-auto whitespace-pre-wrap">
        {loading ? "Loading…" : text || "(empty)"}
      </pre>
    </Dialog>
  );
}
