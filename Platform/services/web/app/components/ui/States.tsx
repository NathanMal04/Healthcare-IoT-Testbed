import { CircleCheck, Info, LoaderCircle, TriangleAlert, X, type LucideIcon } from "lucide-react";

export function LoadingState({ label = "Loading…", className = "" }: { label?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center gap-2 py-10 text-sm text-slate-500 ${className}`} role="status">
      <LoaderCircle className="h-4 w-4 animate-spin text-brand-500" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = "",
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center text-center px-6 py-12 ${className}`}>
      <span className="h-11 w-11 rounded-xl bg-surface-sunken text-slate-400 flex items-center justify-center mb-3">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="text-sm font-medium text-slate-800">{title}</p>
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
}: {
  title?: string;
  message: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center text-center px-6 py-10 ${className}`} role="alert">
      <span className="h-11 w-11 rounded-xl bg-red-50 text-red-500 flex items-center justify-center mb-3">
        <TriangleAlert className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="text-sm font-medium text-slate-800">{title}</p>
      <p className="text-sm text-slate-500 mt-1 max-w-md break-words">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
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
