"use client";

import Link from "next/link";
import { FolderArchive, ShieldAlert, type LucideIcon } from "lucide-react";
import type { Device } from "@/lib/devices";
import type { Figure } from "@/lib/deviceList";
import { deviceHref } from "@/lib/routes";
import ProfileAvatar from "@/app/components/images/ProfileAvatar";
import type { ImageUrls } from "@/app/components/images/useImageData";
import { ReStatusBadge, Skeleton, formatDay } from "@/app/components/ui";
import { DeviceActionsMenu, FigureValue, roleLabel, type DeviceActionHandlers } from "./parts";

function Stat({ icon: Icon, label, figure }: { icon: LucideIcon; label: string; figure: Figure }) {
  return (
    <div className="rounded-lg bg-surface-muted px-3 py-2">
      <dt className="flex items-center gap-1.5 text-2xs font-medium text-slate-500">
        <Icon className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
        {label}
      </dt>
      <dd className="mt-0.5 text-sm font-semibold text-slate-900">
        <FigureValue figure={figure} label={label} />
      </dd>
    </div>
  );
}

/**
 * One device in the grid: its profile picture, identity, figures and menu.
 * The whole card opens the device (its name is the link, stretched over the
 * card); the menu sits above that link so it stays separately clickable.
 */
export default function DeviceCard({
  device,
  figures,
  urls,
  handlers,
}: {
  device: Device;
  figures: { cves: Figure; artifacts: Figure };
  urls: ImageUrls;
  handlers: DeviceActionHandlers;
}) {
  const make = [device.manufacturer, device.modelNumber].filter(Boolean);
  return (
    <article className="group relative flex w-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-card transition-[border-color,box-shadow,transform] motion-safe:duration-150 hover:border-line-strong hover:shadow-md motion-safe:hover:-translate-y-0.5">
      <div className="relative aspect-[4/3] overflow-hidden border-b border-line bg-surface-sunken">
        <ProfileAvatar
          key={device.profileImageArtifactId ?? "none"}
          artifactId={device.profileImageArtifactId}
          urls={urls}
          alt={`Profile picture of ${device.name}`}
          size="fill"
          className="motion-safe:transition-transform motion-safe:duration-300 motion-safe:group-hover:scale-[1.03]"
        />
        <span className="absolute left-3 top-3 rounded-md shadow-sm">
          <ReStatusBadge status={device.reverseEngineeringStatus} />
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="text-section text-slate-900 break-words">
          <Link
            href={deviceHref(device.deviceId)}
            className="outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-brand-500 focus-visible:after:ring-offset-1 group-hover:text-brand-700"
          >
            {device.name}
          </Link>
        </h3>
        <dl className="mt-1 space-y-0.5 text-xs text-slate-500">
          {make.length > 0 && (
            <div className="flex gap-1 min-w-0">
              <dt className="sr-only">Manufacturer and model</dt>
              <dd className="truncate">
                {device.manufacturer && <span className="text-slate-700">{device.manufacturer}</span>}
                {device.manufacturer && device.modelNumber && <span aria-hidden="true"> · </span>}
                {device.modelNumber && <span className="font-mono">{device.modelNumber}</span>}
              </dd>
            </div>
          )}
          {device.type && (
            <div>
              <dt className="sr-only">Type</dt>
              <dd className="truncate">{device.type}</dd>
            </div>
          )}
        </dl>
        {device.description && <p className="mt-2 text-xs leading-5 text-slate-600 line-clamp-2">{device.description}</p>}

        <dl className="mt-auto grid grid-cols-2 gap-2 pt-4">
          <Stat icon={ShieldAlert} label="CVEs" figure={figures.cves} />
          <Stat icon={FolderArchive} label="Artifacts" figure={figures.artifacts} />
        </dl>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2">
        <p className="text-xs text-slate-500 truncate">
          {device.updatedAt ? (
            <>
              Updated <time dateTime={device.updatedAt}>{formatDay(device.updatedAt)}</time>
            </>
          ) : (
            <>{roleLabel(device.role)} access</>
          )}
        </p>
        {/* Above the stretched link, so the menu isn't the card's link. */}
        <div className="relative z-10 -mr-2">
          <DeviceActionsMenu device={device} handlers={handlers} />
        </div>
      </div>
    </article>
  );
}

/** A card-shaped placeholder while the devices load. */
export function DeviceCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card" aria-hidden="true">
      <Skeleton className="aspect-[4/3] w-full rounded-none" />
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
        <div className="grid grid-cols-2 gap-2 pt-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      </div>
    </div>
  );
}
