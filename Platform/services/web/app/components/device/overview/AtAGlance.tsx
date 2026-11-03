"use client";

import Link from "next/link";
import { FolderArchive, Images, Microchip, RotateCw, ShieldAlert, type LucideIcon } from "lucide-react";
import { countDescription, countText, type Count } from "@/lib/deviceOverview";
import { Skeleton, focusRing } from "@/app/components/ui";

export interface GlanceTile {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
  /** null while loading. */
  count: Count | null;
  /** A short line under the number (what it includes, or what's notable). */
  caption?: React.ReactNode;
  /** The count couldn't be loaded. */
  error?: string | null;
  onRetry?: () => void;
}

export const GLANCE_ICONS = { firmware: Microchip, cves: ShieldAlert, images: Images, files: FolderArchive };

/**
 * The device's counts, each opening its section. A count from the first
 * page of a paged list reads "N+" ("at least N" to screen readers).
 */
export default function AtAGlance({ tiles }: { tiles: GlanceTile[] }) {
  return (
    <section aria-labelledby="overview-glance-heading">
      <h2 id="overview-glance-heading" className="sr-only">
        At a glance
      </h2>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((tile) => (
          <li key={tile.key} className="min-w-0">
            <Tile tile={tile} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Tile({ tile }: { tile: GlanceTile }) {
  const Icon = tile.icon;
  const value = tile.error ? (
    <span className="text-slate-300" aria-hidden="true">
      —
    </span>
  ) : tile.count ? (
    <span aria-hidden="true">{countText(tile.count)}</span>
  ) : (
    <Skeleton className="mt-1 h-7 w-10" />
  );
  const spoken = tile.error ? "couldn't be loaded" : tile.count ? countDescription(tile.count) : "loading";
  return (
    <div className="flex h-full flex-col rounded-xl border border-line bg-white shadow-card transition-colors hover:border-line-strong">
      <Link
        href={tile.href}
        scroll={false}
        className={`flex flex-1 flex-col rounded-xl p-3 sm:p-4 ${focusRing}`}
        title={tile.count && !tile.count.exact ? `${tile.label}: ${countDescription(tile.count)}` : undefined}
      >
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0 hyphens-auto break-words text-meta font-medium leading-snug text-slate-500" lang="en">{tile.label}</span>
          <Icon className="h-4 w-4 shrink-0 text-brand-600" aria-hidden="true" />
        </span>
        <span className="mt-1.5 block text-2xl font-semibold tabular-nums text-slate-900">{value}</span>
        <span className="sr-only">
          {tile.label}: {spoken}
        </span>
        {(tile.caption || tile.error) && (
          <span className={`mt-1 block text-meta ${tile.error ? "text-danger-700" : "text-slate-500"}`}>
            {tile.error ? "Couldn't load" : tile.caption}
          </span>
        )}
      </Link>
      {tile.error && tile.onRetry && (
        <button
          type="button"
          onClick={tile.onRetry}
          className={`mx-3 mb-3 sm:mx-4 inline-flex items-center gap-1 self-start rounded-md text-meta font-medium text-brand-700 hover:text-brand-800 ${focusRing}`}
        >
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          Retry
          <span className="sr-only"> {tile.label.toLowerCase()}</span>
        </button>
      )}
    </div>
  );
}
