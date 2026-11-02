import { CircleCheck, Info, LoaderCircle, TriangleAlert, X, type LucideIcon } from "lucide-react";

export function LoadingState({ label = "Loading…", className = "" }: { label?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center gap-2 py-10 text-sm text-slate-500 ${className}`} role="status">
      <LoaderCircle className="h-4 w-4 animate-spin text-brand-500" aria-hidden="true" />
      {label}
    </div>
  );
}

/** The heading level of a state's title, to fit the page's outline. */
export type StateHeadingLevel = 2 | 3 | 4;

function StateTitle({ level, children }: { level: StateHeadingLevel; children: React.ReactNode }) {
  const Tag = `h${level}` as "h2" | "h3" | "h4";
  return <Tag className="text-sm font-medium text-slate-800">{children}</Tag>;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = "",
  headingLevel = 3,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /** Its title is a heading (default h3, inside a page section or card). */
  headingLevel?: StateHeadingLevel;
}) {
  return (
    <div className={`flex flex-col items-center text-center px-6 py-12 ${className}`}>
      <span className="h-11 w-11 rounded-xl bg-surface-sunken text-slate-400 flex items-center justify-center mb-3">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <StateTitle level={headingLevel}>{title}</StateTitle>
      {description && <p className="text-sm text-slate-500 mt-1 max-w-md">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  action,
  className = "",
  headingLevel = 3,
}: {
  title?: string;
  message: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  headingLevel?: StateHeadingLevel;
}) {
  return (
    <div className={`flex flex-col items-center text-center px-6 py-10 ${className}`} role="alert">
      <span className="h-11 w-11 rounded-xl bg-red-50 text-red-500 flex items-center justify-center mb-3">
        <TriangleAlert className="h-5 w-5" aria-hidden="true" />
      </span>
      <StateTitle level={headingLevel}>{title}</StateTitle>
      <div className="text-sm text-slate-500 mt-1 max-w-md break-words">{message}</div>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * A placeholder block while content loads (decorative: the region that
 * loads should say so with aria-busy or a LoadingState).
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`block rounded-md bg-surface-sunken motion-safe:animate-pulse ${className}`} />;
}

/** A few lines of placeholder text. */
export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <span aria-hidden="true" className={`block space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 && lines > 1 ? "w-2/3" : "w-full"}`} />
      ))}
    </span>
  );
}

type AlertTone = "error" | "warning" | "success" | "info";

const ALERT_STYLES: Record<AlertTone, { box: string; icon: LucideIcon }> = {
  error: { box: "text-red-700 bg-red-50 border-red-100", icon: TriangleAlert },
  warning: { box: "text-amber-800 bg-amber-50 border-amber-100", icon: TriangleAlert },
  success: { box: "text-emerald-700 bg-emerald-50 border-emerald-100", icon: CircleCheck },
  info: { box: "text-brand-800 bg-brand-50 border-brand-100", icon: Info },
};

/** An inline message inside a page, card or dialog. */
export function Alert({
  tone = "error",
  children,
  onDismiss,
  action,
  className = "",
}: {
  tone?: AlertTone;
  children: React.ReactNode;
  onDismiss?: () => void;
  action?: React.ReactNode;
  className?: string;
}) {
  const style = ALERT_STYLES[tone];
  const Icon = style.icon;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2 text-xs border rounded-lg px-3 py-2 ${style.box} ${className}`}
    >
      <Icon className="h-4 w-4 shrink-0 mt-px" aria-hidden="true" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
