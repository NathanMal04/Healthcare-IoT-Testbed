"use client";

import type { Device } from "@/lib/devices";
import type { Artifact } from "@/lib/artifacts";
import { firmwareBreakdown, otherFilesCount, pageCount, severityDistribution } from "@/lib/deviceOverview";
import { deviceSectionHref } from "@/lib/deviceView";
import AtAGlance, { GLANCE_ICONS, type GlanceTile } from "../overview/AtAGlance";
import LinkedVulnerabilitiesCard from "../overview/LinkedVulnerabilitiesCard";
import NotebookActivityCard from "../overview/NotebookActivityCard";
import RecentImagesCard from "../overview/RecentImagesCard";
import ResearchStatusCard from "../overview/ResearchStatusCard";
import SpecificationsCard from "../overview/SpecificationsCard";
import type { DeviceCves } from "../useDeviceCves";
import type { OverviewData } from "../useOverviewData";

/**
 * The device at a glance for research: its counts, research status and
 * firmware progress, specifications, linked vulnerabilities, notebook
 * activity and newest images. Every figure comes from an existing API; each
 * card loads, fails and empties on its own.
 */
export default function OverviewSection({
  device,
  canEdit,
  firmware,
  firmwareError,
  reloadFirmware,
  cves,
  overview,
  onDeviceChange,
  onEdit,
}: {
  device: Device;
  canEdit: boolean;
  firmware: Artifact[] | null;
  firmwareError: string | null;
  reloadFirmware: () => void;
  cves: DeviceCves;
  overview: OverviewData;
  /** Applies a change to the latest device state, not to this render's copy. */
  onDeviceChange: (update: (current: Device) => Device) => void;
  onEdit: () => void;
}) {
  const href = (section: Parameters<typeof deviceSectionHref>[1]) => deviceSectionHref(device.deviceId, section);
  const cvesLoaded = cves.cves !== null;
  const { artifacts, images } = overview;

  const firmwareCaption = () => {
    if (!firmware) return undefined;
    if (firmware.length === 0) return "None uploaded";
    const { counts, notReady } = firmwareBreakdown(firmware);
    // Reverse-engineering progress and upload readiness are separate facts; both are named.
    const reDone = `${counts.complete} RE complete`;
    return notReady > 0 ? `${reDone} · ${notReady} ${notReady === 1 ? "upload" : "uploads"} not ready` : reDone;
  };
  const cveCaption = () => {
    if (!cvesLoaded) return undefined;
    if (cves.deviceCves.length === 0) return "None linked";
    const [critical, high] = severityDistribution(cves.deviceCves);
    return critical.count + high.count > 0 ? `${critical.count} critical · ${high.count} high` : "None critical or high";
  };

  const tiles: GlanceTile[] = [
    {
      key: "firmware",
      label: "Firmware versions",
      icon: GLANCE_ICONS.firmware,
      href: href("firmware"),
      count: firmware ? { value: firmware.length, exact: true } : null,
      caption: firmwareCaption(),
      error: firmware ? null : firmwareError,
      onRetry: reloadFirmware,
    },
    {
      key: "cves",
      label: "Linked vulnerabilities",
      icon: GLANCE_ICONS.cves,
      href: href("cves"),
      count: cvesLoaded ? { value: cves.deviceCves.length, exact: true } : null,
      caption: cveCaption(),
      error: cvesLoaded ? null : cves.error,
      onRetry: () => void cves.load(),
    },
    {
      key: "images",
      label: "Images",
      icon: GLANCE_ICONS.images,
      href: href("images"),
      count: images.data ? pageCount(images.data.images, images.data.nextToken) : null,
      caption: images.data && images.data.nextToken ? "More in Images" : undefined,
      error: images.data ? null : images.error,
      onRetry: images.reload,
    },
    {
      key: "files",
      label: "Other files",
      icon: GLANCE_ICONS.files,
      href: href("artifacts"),
      count: artifacts.data ? otherFilesCount(artifacts.data) : null,
      caption: "Excluding firmware and images",
      error: artifacts.data ? null : artifacts.error,
      onRetry: artifacts.reload,
    },
  ];

  return (
    <div className="space-y-4">
      <AtAGlance tiles={tiles} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <ResearchStatusCard
            device={device}
            canEdit={canEdit}
            firmware={firmware}
            firmwareError={firmwareError}
            firmwareHref={href("firmware")}
            onDeviceChange={onDeviceChange}
          />
          <SpecificationsCard device={device} canEdit={canEdit} onEdit={onEdit} />
        </div>
        <div className="min-w-0 space-y-4">
          <LinkedVulnerabilitiesCard
            device={device}
            allCves={cves.cves}
            deviceCves={cves.deviceCves}
            error={cves.error}
            loading={cves.loading}
            devices={cves.scopeDevices}
            devicesError={cves.scopeDevicesError}
            canLink={canEdit}
            listHref={href("cves")}
            onRetry={() => void cves.load()}
            onChanged={cves.upsert}
          />
          <NotebookActivityCard deviceId={device.deviceId} notebook={overview.notebook} canEdit={canEdit} />
          <RecentImagesCard images={images} imagesHref={href("images")} />
        </div>
      </div>
    </div>
  );
}
