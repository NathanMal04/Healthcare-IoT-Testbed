import {
  REVERSE_ENGINEERING_STATUS_LABELS,
  toReverseEngineeringStatus,
  type ReverseEngineeringStatus,
} from "@/lib/reverseEngineering";

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "orange" | "danger" | "info";

// Semantic tokens (tailwind.config.ts); the same colours as before.
const TONES: Record<BadgeTone, { badge: string; dot: string }> = {
  neutral: { badge: "text-slate-600 bg-slate-100 ring-slate-200", dot: "bg-slate-400" },
  brand: { badge: "text-brand-700 bg-brand-50 ring-brand-100", dot: "bg-brand-500" },
  success: { badge: "text-success-700 bg-success-50 ring-success-100", dot: "bg-success-500" },
  warning: { badge: "text-warning-700 bg-warning-50 ring-warning-100", dot: "bg-warning-500" },
  orange: { badge: "text-orange-700 bg-orange-50 ring-orange-100", dot: "bg-orange-500" },
  danger: { badge: "text-danger-700 bg-danger-50 ring-danger-100", dot: "bg-danger-500" },
  info: { badge: "text-info-700 bg-info-50 ring-info-100", dot: "bg-info-500" },
};

const SIZES = {
  sm: "px-1.5 py-px text-2xs",
  md: "px-2 py-0.5 text-xs",
} as const;

/** A small rounded label. Every status badge in the app is one of these. */
export function Badge({
  tone = "neutral",
  dot = false,
  size = "md",
  title,
  className = "",
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  /** "sm" for dense tables and lists. */
  size?: keyof typeof SIZES;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const style = TONES[tone];
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md font-medium whitespace-nowrap ring-1 ring-inset ${SIZES[size]} ${style.badge} ${className}`}
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
  waiting: "warning",
  launching: "info",
  stopping: "neutral",
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
      {status.replace(/_/g, " ")}
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
