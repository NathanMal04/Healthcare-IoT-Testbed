"use client";

import { CircleCheck, CircleDashed, Cpu, LoaderCircle, type LucideIcon } from "lucide-react";
import type { ReProgress } from "@/lib/dashboard";
import type { ReverseEngineeringStatus } from "@/lib/reverseEngineering";
import { Skeleton } from "@/app/components/ui";

interface SummaryCard {
  /** null is the total; a status filters by it. */
  status: ReverseEngineeringStatus | null;
  label: string;
  icon: LucideIcon;
  /** Icon tile and progress bar colours (full class names, so Tailwind keeps them). */
  tone: { tile: string; bar: string };
}

const CARDS: SummaryCard[] = [
  { status: null, label: "Total devices", icon: Cpu, tone: { tile: "bg-brand-50 text-brand-600", bar: "bg-brand-500" } },
  {
    status: "complete",
    label: "RE completed",
    icon: CircleCheck,
    tone: { tile: "bg-success-50 text-success-600", bar: "bg-success-500" },
  },
  {
    status: "in_progress",
    label: "RE in progress",
    icon: LoaderCircle,
    tone: { tile: "bg-warning-50 text-warning-600", bar: "bg-warning-500" },
  },
  {
    status: "not_started",
    label: "RE not started",
    icon: CircleDashed,
    tone: { tile: "bg-slate-100 text-slate-500", bar: "bg-slate-400" },
  },
];

/**
 * The scope's devices by reverse-engineering status, from the device list
 * itself (every device in the scope, whatever the filters). Each card is
 * also a filter: choosing a status shows only those devices, choosing it
 * again (or the total) shows every status.
 */
export default function DeviceSummaryCards({
  progress,
  loading,
  activeStatus,
  onSelectStatus,
}: {
  progress: ReProgress | null;
  loading: boolean;
  activeStatus: ReverseEngineeringStatus | "";
  onSelectStatus: (status: ReverseEngineeringStatus | "") => void;
}) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6" role="group" aria-label="Devices by reverse-engineering status">
      {CARDS.map((card) => {
        const Icon = card.icon;
        const value = progress ? (card.status ? progress.counts[card.status] : progress.total) : null;
        const percent = progress && card.status ? progress.percents[card.status] : null;
        const pressed = card.status === null ? activeStatus === "" : activeStatus === card.status;
        const disabled = loading || progress === null;
        return (
          <button
            key={card.label}
            type="button"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={() => onSelectStatus(card.status === null || pressed ? "" : card.status)}
            title={card.status ? (pressed ? "Show every status" : `Show only ${card.label.replace("RE ", "")} devices`) : "Show every status"}
            className={`group text-left rounded-xl border bg-surface p-4 shadow-card transition-[border-color,box-shadow] motion-safe:duration-150 outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:cursor-default ${
              pressed && card.status ? "border-brand-500 ring-1 ring-brand-500" : "border-line enabled:hover:border-line-strong enabled:hover:shadow-md"
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-500">{card.label}</span>
              <span className={`h-8 w-8 shrink-0 rounded-lg flex items-center justify-center ${card.tone.tile}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
            </span>
            <span className="mt-1.5 flex items-baseline gap-2">
              {value === null ? (
                <Skeleton className="h-7 w-10 mt-1" />
              ) : (
                <span className="text-2xl font-semibold text-slate-900 tabular-nums">{value}</span>
              )}
              {percent !== null && progress && progress.total > 0 && (
                <span className="text-xs text-slate-500 tabular-nums">{percent}%</span>
              )}
            </span>
            {card.status && (
              <span className="mt-3 block h-1 rounded-full bg-surface-sunken overflow-hidden" aria-hidden="true">
                <span className={`block h-full rounded-full ${card.tone.bar}`} style={{ width: `${percent ?? 0}%` }} />
              </span>
            )}
            {!card.status && (
              <span className="mt-2 block text-xs text-slate-500">Across every status</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
