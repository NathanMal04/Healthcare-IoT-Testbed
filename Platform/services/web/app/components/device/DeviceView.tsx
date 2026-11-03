"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { canEditDevice } from "@/lib/devices";
import {
  DEVICE_PAGE_SECTIONS,
  DEVICE_SECTION_LABELS,
  deviceCrumbs,
  deviceSectionFromParams,
  deviceSectionHref,
  isDevicePageUrl,
  mountedSections,
  sectionActivity,
  type DevicePageSection,
  type DeviceSection,
} from "@/lib/deviceView";
import { scopeWorkspaceId } from "@/lib/workspaces";
import { ScopeLockReporter, useWorkspace } from "@/context/WorkspaceContext";
import EditDeviceDialog from "@/app/components/EditDeviceDialog";
import { usePageCrumbs } from "@/app/components/shell/ShellContext";
import { Alert, LoadingState, NavigationGuard } from "@/app/components/ui";
import DeviceHeader from "./DeviceHeader";
import DeviceSectionNav from "./DeviceSectionNav";
import { DeviceLoadError, DeviceNotFound } from "./DeviceStates";
import { useDevice } from "./useDevice";
import { useDeviceCves } from "./useDeviceCves";
import { useDeviceFirmware } from "./useDeviceFirmware";
import { useDeviceProfilePicture } from "./useDeviceProfilePicture";
import ArtifactsSection from "./sections/ArtifactsSection";
import CvesSection from "./sections/CvesSection";
import DeviceCveDetail from "./sections/DeviceCveDetail";
import FirmwareSection from "./sections/FirmwareSection";
import ImagesSection from "./sections/ImagesSection";
import OverviewSection from "./sections/OverviewSection";

/**
 * One device's research workspace in the current scope: its identity header,
 * section navigation and the open section. The section comes from the URL,
 * so every section is a link, Back and Forward move between sections, and
 * deep links open the right one. Mounted per scope and device (the route
 * keys it), so nothing carries over when either changes.
 *
 * A section with an upload or save running stays mounted (hidden) when
 * another one is opened, by link, Back or Forward, so the work carries on
 * and its outcome is there to come back to. Leaving the device page by an
 * in-app link while work runs asks first; reloading or closing the tab gets
 * the browser's prompt.
 */
export default function DeviceView({ deviceId }: { deviceId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const section = deviceSectionFromParams(searchParams);
  // A linked CVE opened from Vulnerabilities; in the URL so Back returns to the list.
  const openCveId = searchParams.get("cve");
  const { scope, scopeLocked, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);

  const { device, notFound, loadError, setDevice, updateDevice, load: loadDevice } = useDevice(deviceId, workspaceId);
  const cves = useDeviceCves(deviceId, workspaceId, reportWorkspaceUnavailable);
  const firmware = useDeviceFirmware(deviceId, device);
  const picture = useDeviceProfilePicture(device, updateDevice);
  const [editing, setEditing] = useState(false);
  // The open linked CVE's ID, for the breadcrumb, once its details have loaded.
  const [cveLabel, setCveLabel] = useState<{ cveRecordId: string; label?: string } | null>(null);
  const onCveLabel = useCallback((cveRecordId: string, label: string | undefined) => {
    setCveLabel((current) =>
      current?.cveRecordId === cveRecordId && current.label === label ? current : { cveRecordId, label }
    );
  }, []);

  // Which sections stay mounted besides the open one (work in progress).
  const [activity, dispatchActivity] = useReducer(sectionActivity, { open: section, busy: [], kept: [] });
  useEffect(() => dispatchActivity({ type: "opened", section }), [section]);
  const reportBusy = useMemo(
    () =>
      Object.fromEntries(
        DEVICE_PAGE_SECTIONS.map((s) => [s, (busy: boolean) => dispatchActivity({ type: "busy", section: s, busy })])
      ) as Record<DevicePageSection, (busy: boolean) => void>,
    []
  );
  const staysOnPage = useCallback((url: URL) => isDevicePageUrl(url, deviceId), [deviceId]);

  // The device and the scope's CVEs load together, and again together.
  const loadCves = cves.load;
  useEffect(() => {
    const cancel = loadDevice();
    void loadCves();
    return cancel;
  }, [loadDevice, loadCves]);

  // Overview's count tiles open their sections like the navigation does.
  const openSection = useCallback(
    (next: DeviceSection) => router.push(deviceSectionHref(deviceId, next), { scroll: next === "notebook" }),
    [router, deviceId]
  );

  const scopeName = scope.kind === "workspace" ? scope.name : "Personal";
  usePageCrumbs(
    device
      ? deviceCrumbs(
          device,
          section,
          openCveId ? { label: cveLabel?.cveRecordId === openCveId ? cveLabel.label : undefined } : null
        )
      : null
  );

  if (loadError) return <DeviceLoadError message={loadError} />;
  if (notFound) return <DeviceNotFound scopeName={scopeName} />;
  if (!device) return <LoadingState label="Loading device…" />;

  const loaded = device;
  const canEdit = canEditDevice(loaded);
  const cveCount = cves.cves ? cves.deviceCves.length : null;

  function renderSection(s: DevicePageSection): React.ReactNode {
    switch (s) {
      case "overview":
        return (
          <OverviewSection
            device={loaded}
            scope={scope}
            firmware={firmware.firmware}
            cveCount={cveCount}
            onDeviceChange={updateDevice}
            onOpenSection={openSection}
          />
        );
      case "firmware":
        return (
          <FirmwareSection
            device={loaded}
            firmware={firmware.firmware}
            setFirmware={firmware.setFirmware}
            error={firmware.error}
            reload={firmware.reload}
          />
        );
      case "artifacts":
        return <ArtifactsSection device={loaded} />;
      case "images":
        return <ImagesSection device={loaded} canEdit={canEdit} picture={picture} />;
      case "cves":
        return openCveId ? (
          <DeviceCveDetail
            deviceId={deviceId}
            cveRecordId={openCveId}
            onChanged={cves.upsert}
            onDeleted={cves.remove}
            onLabel={onCveLabel}
          />
        ) : (
          <CvesSection
            device={loaded}
            scope={scope}
            allCves={cves.cves}
            deviceCves={cves.deviceCves}
            error={cves.error}
            devices={cves.scopeDevices}
            devicesError={cves.scopeDevicesError}
            refreshing={cves.loading}
            onRefresh={() => void cves.load()}
            onChanged={cves.upsert}
            onRemoved={cves.remove}
          />
        );
    }
  }

  return (
    <div>
      <DeviceHeader device={loaded} scope={scope} canEdit={canEdit} picture={picture} onEdit={() => setEditing(true)} />

      <div className="xl:flex xl:items-start xl:gap-6">
        <DeviceSectionNav
          deviceId={deviceId}
          active={section}
          counts={{ firmware: firmware.firmware?.length, cves: cveCount ?? undefined }}
        />

        <div id="device-section" className="min-w-0 flex-1 pt-5 xl:pt-0">
          {activity.kept
            .filter((s) => s !== section)
            .map((s) => (
              <BackgroundWorkNotice
                key={s}
                section={s}
                running={activity.busy.includes(s)}
                href={deviceSectionHref(deviceId, s)}
                onDismiss={() => dispatchActivity({ type: "dismissed", section: s })}
              />
            ))}
          {mountedSections({ ...activity, open: section }).map((s) => (
            <SectionSlot key={s} hidden={s !== section} onBusyChange={reportBusy[s]}>
              {renderSection(s)}
            </SectionSlot>
          ))}
        </div>
      </div>

      {editing && <EditDeviceDialog device={loaded} onClose={() => setEditing(false)} onSaved={setDevice} />}

      {/*
        Uploads and saves on this page hold the workspace (the scope lock).
        While one runs, other sections are safe to open (the busy one stays
        mounted), but leaving the device page by a link asks first, and
        reloading or closing the tab gets the browser's prompt.
      */}
      <NavigationGuard
        active={scopeLocked}
        staysOnPage={staysOnPage}
        message="An upload or change on this device is still in progress. Leaving this page now may interrupt it."
      />
    </div>
  );
}

/**
 * One section of the page. Hidden (and inert, so nothing in it can take
 * focus) while another section is open; reports whether anything in it holds
 * the workspace, which keeps it mounted.
 */
function SectionSlot({
  hidden,
  onBusyChange,
  children,
}: {
  hidden: boolean;
  onBusyChange: (busy: boolean) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.toggleAttribute("inert", hidden);
  }, [hidden]);
  return (
    <div ref={ref} hidden={hidden} data-device-section="">
      <ScopeLockReporter onChange={onBusyChange}>{children}</ScopeLockReporter>
    </div>
  );
}

/** Says that a section not on screen still has work running, or has finished it. */
function BackgroundWorkNotice({
  section,
  running,
  href,
  onDismiss,
}: {
  section: DevicePageSection;
  running: boolean;
  href: string;
  onDismiss: () => void;
}) {
  const label = DEVICE_SECTION_LABELS[section];
  return (
    <Alert tone={running ? "info" : "success"} className="mb-4" onDismiss={running ? undefined : onDismiss}>
      {running ? (
        <>An upload or change in {label} is still running. It carries on while you use other sections. </>
      ) : (
        <>The upload or change in {label} has finished. </>
      )}
      <Link href={href} scroll={false} className="font-medium underline underline-offset-2">
        {running ? `Go to ${label}` : `View ${label}`}
      </Link>
    </Alert>
  );
}
