"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";

/** Redirects to /login once auth has loaded without a user. Returns true when the page may render. */
export function useRequireUser(): boolean {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);
  return !loading && !!user;
}

const BADGE_STYLES: Record<string, string> = {
  ready: "text-emerald-700 bg-emerald-50",
  completed: "text-emerald-700 bg-emerald-50",
  succeeded: "text-emerald-700 bg-emerald-50",
  pending: "text-amber-700 bg-amber-50",
  queued: "text-amber-700 bg-amber-50",
  building: "text-blue-700 bg-blue-50",
  verifying: "text-blue-700 bg-blue-50",
  running: "text-blue-700 bg-blue-50",
  failed: "text-red-700 bg-red-50",
  build_failed: "text-red-700 bg-red-50",
  rejected: "text-red-700 bg-red-50",
  stopped: "text-red-700 bg-red-50",
  cancelled: "text-slate-600 bg-slate-100",
};

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${
        BADGE_STYLES[status] ?? "text-slate-600 bg-slate-100"
      }`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
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
    <div
      className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-slate-800">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>
        <pre className="text-xs bg-slate-950 text-slate-100 rounded-lg p-4 max-h-[70vh] overflow-auto whitespace-pre-wrap">
          {loading ? "Loading…" : text || "(empty)"}
        </pre>
      </div>
    </div>
  );
}

export const inputClass =
  "w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50";
export const labelClass = "block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5";
export const primaryButton =
  "text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-medium transition-colors";
export const secondaryButton =
  "text-sm bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-600 border border-slate-200 px-4 py-2 rounded-lg transition-colors";
export const cardClass = "bg-white rounded-2xl border border-slate-100 shadow-sm";
