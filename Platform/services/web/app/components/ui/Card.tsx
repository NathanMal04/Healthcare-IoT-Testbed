import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cardClass } from "./styles";

export function Card({
  className = "",
  children,
  as: Tag = "div",
}: {
  className?: string;
  children: React.ReactNode;
  as?: "div" | "section";
}) {
  return <Tag className={`${cardClass} ${className}`}>{children}</Tag>;
}

/** A card's title row, with optional description and actions on the right. */
export function CardHeader({
  title,
  description,
  actions,
  className = "",
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`px-5 py-4 border-b border-line flex flex-wrap items-center gap-3 ${className}`}>
      <div className="min-w-0 mr-auto">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/** One figure on the dashboard. `value` is shown as given (e.g. "12" or "100+"). */
export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  href,
  loading = false,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon: LucideIcon;
  href?: string;
  loading?: boolean;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <span className="h-8 w-8 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>
      <p className="text-2xl font-semibold text-slate-900 mt-2 tabular-nums">
        {loading ? <span className="inline-block h-7 w-12 rounded bg-surface-sunken animate-pulse align-middle" /> : value}
      </p>
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </>
  );
  const className = `${cardClass} p-4 block`;
  return href ? (
    <Link href={href} className={`${className} hover:border-line-strong hover:shadow-md transition-shadow`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
