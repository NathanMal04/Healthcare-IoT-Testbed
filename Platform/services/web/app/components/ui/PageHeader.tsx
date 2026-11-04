import Link from "next/link";
import { ArrowLeft, Building2, Eye, UserRound } from "lucide-react";
import type { Scope } from "@/lib/workspaces";

/**
 * "Personal" or "Workspace · Lab", so every scoped page says whose data it
 * shows; a workspace the user can only view adds a "Read-only" mark.
 */
export function ScopeLabel({ scope }: { scope: Scope }) {
  return scope.kind === "workspace" ? (
    <span className="inline-flex items-center gap-1 text-slate-600">
      <Building2 className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
      Workspace · <span className="font-medium text-slate-700">{scope.name}</span>
      {scope.role === "viewer" && <ReadOnlyMark className="ml-1" />}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-slate-600">
      <UserRound className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
      Personal
    </span>
  );
}

/** A subtle "Read-only" pill for a workspace the user can view but not change. */
export function ReadOnlyMark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-line bg-surface-sunken px-1.5 py-px text-2xs font-medium text-slate-600 ${className}`}
      title="You can view and download this workspace's research, but not change it."
    >
      <Eye className="h-3 w-3" aria-hidden="true" />
      Read-only
    </span>
  );
}

export function PageHeader({
  title,
  description,
  scope,
  actions,
  back,
  meta,
  leading,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Shown after the description so the page states its scope. */
  scope?: Scope;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  /** Extra content under the title row (badges, facts). */
  meta?: React.ReactNode;
  /** Shown before the title, e.g. a device's profile picture. */
  leading?: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      {back && (
        <Link
          href={back.href}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700 mb-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex items-start gap-3 sm:gap-4">
          {leading}
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight break-words">{title}</h1>
            {(description || scope) && (
              <p className="text-sm text-slate-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                {description && <span>{description}</span>}
                {description && scope && <span className="text-slate-300" aria-hidden="true">·</span>}
                {scope && <ScopeLabel scope={scope} />}
              </p>
            )}
            {meta && <div className="mt-3">{meta}</div>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
