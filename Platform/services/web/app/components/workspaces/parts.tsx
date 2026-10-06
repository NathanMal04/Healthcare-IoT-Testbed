import { Building2, Check, Cpu, Lock, Microchip, ShieldAlert, Users, type LucideIcon } from "lucide-react";
import type { WorkspaceMember } from "@/lib/workspaces";
import { Avatar } from "@/app/components/WorkspaceDialogs";
import { firmwareCount, type ScopeResources } from "./useWorkspaceResources";

/** How a card or header is tinted: by the user's role, or Personal. */
export type WorkspaceKind = "owner" | "member" | "personal";

export const KIND_STYLES: Record<WorkspaceKind, { band: string; tile: string; icon: LucideIcon }> = {
  owner: { band: "bg-brand-50 border-brand-100", tile: "text-brand-600", icon: Building2 },
  member: { band: "bg-sky-50 border-sky-100", tile: "text-sky-600", icon: Building2 },
  personal: { band: "bg-surface-sunken border-line", tile: "text-slate-500", icon: Lock },
};

/** The workspace's icon, on a white tile that overlaps the tinted band above it. */
export function KindTile({ kind, size = "md" }: { kind: WorkspaceKind; size?: "md" | "lg" }) {
  const { tile, icon: Icon } = KIND_STYLES[kind];
  const box = size === "lg" ? "h-14 w-14 rounded-2xl" : "h-11 w-11 rounded-xl";
  return (
    <span className={`${box} shrink-0 bg-white border border-line shadow-card flex items-center justify-center ${tile}`}>
      <Icon className={size === "lg" ? "h-6 w-6" : "h-5 w-5"} aria-hidden="true" />
    </span>
  );
}

export function SelectedPill() {
  return (
    <span className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-emerald-700 bg-emerald-50 ring-1 ring-inset ring-emerald-100 rounded-md px-1.5 py-0.5">
      <Check className="h-3 w-3" aria-hidden="true" />
      Selected
    </span>
  );
}

const STACK_LIMIT = 3;

/** Up to three member initials, then "+N". */
export function AvatarStack({ members }: { members: WorkspaceMember[] }) {
  const shown = members.slice(0, STACK_LIMIT);
  const rest = members.length - shown.length;
  return (
    <span className="flex -space-x-1.5">
      {shown.map((m) => (
        <Avatar key={m.userId} email={m.email} size="sm" />
      ))}
      {rest > 0 && (
        <span className="h-7 w-7 rounded-full bg-surface-sunken text-slate-600 text-2xs font-semibold flex items-center justify-center ring-2 ring-white">
          +{rest}
        </span>
      )}
    </span>
  );
}

/** "5 members", a placeholder while loading, or "—" when it couldn't be read. */
export function memberLabel(members: ScopeResources["members"]): string {
  if (members === undefined) return "…";
  if (members === null) return "—";
  return `${members.length} ${members.length === 1 ? "member" : "members"}`;
}

interface Count {
  key: string;
  icon: LucideIcon;
  label: string;
  value: string | null | undefined;
}

/** The counts shown on a card or header, from the scope's loaded resources. */
export function scopeCounts(resources: ScopeResources | undefined, withMembers: boolean): Count[] {
  const count = <T,>(list: T[] | null | undefined) => (list === undefined ? undefined : list === null ? null : String(list.length));
  const counts: Count[] = [
    { key: "devices", icon: Cpu, label: "devices", value: count(resources?.devices) },
    {
      key: "firmware",
      icon: Microchip,
      label: "firmware",
      value: resources?.firmware === undefined ? undefined : firmwareCount(resources.firmware),
    },
    { key: "cves", icon: ShieldAlert, label: "CVEs", value: count(resources?.cves) },
  ];
  if (withMembers) counts.unshift({ key: "members", icon: Users, label: "members", value: count(resources?.members) });
  return counts;
}

/** A row of small icon + number pairs. Loading shows a shimmer; a failed count shows "—". */
export function CountRow({ counts, className = "" }: { counts: Count[]; className?: string }) {
  return (
    <ul className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 ${className}`}>
      {counts.map(({ key, icon: Icon, label, value }) => (
        <li key={key} className="inline-flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
          {value === undefined ? (
            <span className="inline-block h-3 w-5 rounded bg-surface-sunken animate-pulse" aria-label="Loading" />
          ) : (
            <span className="font-medium text-slate-700 tabular-nums">{value ?? "—"}</span>
          )}
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}
