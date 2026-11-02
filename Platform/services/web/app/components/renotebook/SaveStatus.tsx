"use client";

import { CircleCheck, CloudOff, LoaderCircle, PencilLine, TriangleAlert } from "lucide-react";
import type { AutosaveState } from "@/lib/reNotebookAutosave";
import { formatDate } from "@/app/components/ui";

/** The editor's save state, always visible, announced politely to screen readers. */
export default function SaveStatus({ state, onRetry }: { state: AutosaveState; onRetry: () => void }) {
  const { status, lastSavedAt, error } = state;
  let icon = <CircleCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />;
  let text = lastSavedAt ? `Saved · ${formatDate(lastSavedAt)}` : "Saved";
  let tone = "text-slate-500";
  let retry = false;
  if (status === "unsaved") {
    icon = <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />;
    text = "Unsaved changes";
  } else if (status === "saving") {
    icon = <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />;
    text = "Saving…";
  } else if (status === "retrying") {
    icon = <CloudOff className="h-3.5 w-3.5" aria-hidden="true" />;
    text = "Not saved yet · retrying";
    tone = "text-amber-700";
    retry = true;
  } else if (status === "error") {
    icon = <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />;
    text = error ?? "Not saved";
    tone = "text-red-700";
    retry = true;
  } else if (status === "conflict") {
    icon = <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />;
    text = "Not saved · changed by someone else";
    tone = "text-red-700";
  } else if (status === "deleted") {
    icon = <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />;
    text = "Not saved · entry deleted";
    tone = "text-red-700";
  }
  return (
    <div className={`flex items-center gap-1.5 text-xs ${tone}`}>
      <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
        {icon}
        <span>{text}</span>
      </span>
      {retry && (
        <button type="button" onClick={onRetry} className="font-medium underline hover:no-underline">
          Retry now
        </button>
      )}
    </div>
  );
}
