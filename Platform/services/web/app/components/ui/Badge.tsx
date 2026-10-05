import {
  REVERSE_ENGINEERING_STATUS_LABELS,
  toReverseEngineeringStatus,
  type ReverseEngineeringStatus,
} from "@/lib/reverseEngineering";

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "orange" | "danger" | "info";

const TONES: Record<BadgeTone, { badge: string; dot: string }> = {
  neutral: { badge: "text-slate-600 bg-slate-100 ring-slate-200", dot: "bg-slate-400" },
  brand: { badge: "text-brand-700 bg-brand-50 ring-brand-100", dot: "bg-brand-500" },
  success: { badge: "text-emerald-700 bg-emerald-50 ring-emerald-100", dot: "bg-emerald-500" },
  warning: { badge: "text-amber-700 bg-amber-50 ring-amber-100", dot: "bg-amber-500" },
  orange: { badge: "text-orange-700 bg-orange-50 ring-orange-100", dot: "bg-orange-500" },
  danger: { badge: "text-red-700 bg-red-50 ring-red-100", dot: "bg-red-500" },
  info: { badge: "text-sky-700 bg-sky-50 ring-sky-100", dot: "bg-sky-500" },
};

/** A small rounded label. Every status badge in the app is one of these. */
export function Badge({
  tone = "neutral",
  dot = false,
  title,
  className = "",
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const style = TONES[tone];
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap ring-1 ring-inset ${style.badge} ${className}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden="true" />}
      {children}
    </span>
  );
}

// Upload, build and run lifecycle states.
const STATUS_TONES: Record<string, BadgeTone> = {
  ready: "success",
  completed: "success",
  succeeded: "success",
  pending: "warning",
  queued: "warning",
  building: "info",
  verifying: "info",
  running: "info",
  starting: "info",
  failed: "danger",
  build_failed: "danger",
  rejected: "danger",
  stopped: "danger",
  cancelled: "neutral",
  cancelling: "neutral",
};

/** An upload, build or run status ("ready", "build_failed", …). */
export function StatusBadge({ status, title }: { status: string; title?: string }) {
  return (
    <Badge tone={STATUS_TONES[status] ?? "neutral"} title={title} dot>
      {status.replace("_", " ")}
    </Badge>
  );
}

const SEVERITY_TONES: Record<string, BadgeTone> = {
  critical: "danger",
  high: "orange",
  medium: "warning",
  low: "neutral",
};

/** A CVE severity. */
export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge tone={SEVERITY_TONES[severity] ?? "neutral"} className="capitalize" dot>
      {severity}
    </Badge>
  );
}

const RE_TONES: Record<ReverseEngineeringStatus, BadgeTone> = {
  not_started: "neutral",
  in_progress: "warning",
  complete: "success",
};

/** Reverse-engineering progress (devices and firmware only). */
export function ReStatusBadge({ status }: { status: ReverseEngineeringStatus | string | undefined }) {
  const value = toReverseEngineeringStatus(status);
  return (
    <Badge tone={RE_TONES[value]} dot>
      {REVERSE_ENGINEERING_STATUS_LABELS[value]}
    </Badge>
  );
}
