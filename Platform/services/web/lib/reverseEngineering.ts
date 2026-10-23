// Reverse-engineering progress, shared by devices and firmware artifacts. The
// two are set independently, and both are separate from any upload or
// lifecycle "status".

export const REVERSE_ENGINEERING_STATUSES = ["not_started", "in_progress", "complete"] as const;
export type ReverseEngineeringStatus = (typeof REVERSE_ENGINEERING_STATUSES)[number];

export const REVERSE_ENGINEERING_STATUS_LABELS: Record<ReverseEngineeringStatus, string> = {
  not_started: "Not Started",
  in_progress: "In-Progress",
  complete: "Complete",
};

export const REVERSE_ENGINEERING_STATUS_STYLES: Record<ReverseEngineeringStatus, string> = {
  not_started: "text-slate-600 bg-slate-50",
  in_progress: "text-amber-700 bg-amber-50",
  complete: "text-emerald-700 bg-emerald-50",
};

/** Records stored before the field existed haven't been started. */
export function toReverseEngineeringStatus(value: unknown): ReverseEngineeringStatus {
  return REVERSE_ENGINEERING_STATUSES.includes(value as ReverseEngineeringStatus)
    ? (value as ReverseEngineeringStatus)
    : "not_started";
}
