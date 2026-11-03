"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { canEditDevice } from "@/lib/devices";
import type { DeviceSection } from "@/lib/deviceView";
import { deviceHref, notebookHref } from "@/lib/routes";
import { scopeWorkspaceId } from "@/lib/workspaces";
import { useWorkspace } from "@/context/WorkspaceContext";
import EditDeviceDialog from "@/app/components/EditDeviceDialog";
import { usePageCrumbs } from "@/app/components/shell/ShellContext";
import { LoadingState, TabPanel, Tabs } from "@/app/components/ui";
import DeviceHeader from "./DeviceHeader";
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
 * One device's page in the current scope: its header, section tabs and the
 * open section. Mounted per scope and device (the route keys it), so nothing
 * carries over when either changes.
 */
export default function DeviceView({ deviceId, initialSection }: { deviceId: string; initialSection: DeviceSection }) {
  const router = useRouter();
  // A linked CVE opened from the CVEs section; in the URL so Back returns to the list.
  const openCveId = useSearchParams().get("cve");
  const { scope, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);

  const { device, notFound, loadError, setDevice, updateDevice, load: loadDevice } = useDevice(deviceId, workspaceId);
  const cves = useDeviceCves(deviceId, workspaceId, reportWorkspaceUnavailable);
  const firmware = useDeviceFirmware(deviceId, device);
  const picture = useDeviceProfilePicture(device, updateDevice);
  const [section, setSection] = useState<DeviceSection>(initialSection);
  const [editing, setEditing] = useState(false);

  // The device and the scope's CVEs load together, and again together.
  const loadCves = cves.load;
  useEffect(() => {
    const cancel = loadDevice();
    void loadCves();
    return cancel;
  }, [loadDevice, loadCves]);

  function selectSection(next: DeviceSection) {
    // The RE Notebook is a full-screen workspace of its own.
    if (next === "notebook") {
      router.push(notebookHref(deviceId));
      return;
    }
    setSection(next);
    router.replace(deviceHref(deviceId, next === "overview" ? undefined : next), { scroll: false });
  }

  const scopeName = scope.kind === "workspace" ? scope.name : "Personal";
  // The top bar's breadcrumb names the device once it's loaded.
  usePageCrumbs(device ? [{ label: "Devices", href: "/devices" }, { label: device.name }] : null);

  if (loadError) return <DeviceLoadError message={loadError} />;
  if (notFound) return <DeviceNotFound scopeName={scopeName} />;
  if (!device) return <LoadingState label="Loading device…" />;

  const canEdit = canEditDevice(device);
  const cveCount = cves.cves ? cves.deviceCves.length : null;

  return (
    <div>
      <DeviceHeader device={device} scope={scope} canEdit={canEdit} picture={picture} onEdit={() => setEditing(true)} />

      <Tabs
        ariaLabel="Device sections"
        active={section}
        onChange={selectSection}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "firmware", label: "Firmware", count: firmware.firmware ? firmware.firmware.length : undefined },
          { id: "artifacts", label: "Artifacts" },
          { id: "images", label: "Images" },
          { id: "cves", label: "CVEs", count: cveCount ?? undefined },
          { id: "notebook", label: "RE Notebook" },
        ]}
      />

      <TabPanel id={section}>
        {section === "overview" && (
          <OverviewSection
            device={device}
            scope={scope}
            firmware={firmware.firmware}
            cveCount={cveCount}
            onDeviceChange={updateDevice}
            onOpenSection={selectSection}
          />
        )}
        {section === "firmware" && (
          <FirmwareSection
            device={device}
            firmware={firmware.firmware}
            setFirmware={firmware.setFirmware}
            error={firmware.error}
            reload={firmware.reload}
          />
        )}
        {section === "artifacts" && <ArtifactsSection device={device} />}
        {section === "images" && <ImagesSection device={device} canEdit={canEdit} picture={picture} />}
        {section === "cves" && openCveId && (
          <DeviceCveDetail deviceId={deviceId} cveRecordId={openCveId} onChanged={cves.upsert} onDeleted={cves.remove} />
        )}
        {section === "cves" && !openCveId && (
          <CvesSection
            device={device}
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
        )}
      </TabPanel>

      {editing && <EditDeviceDialog device={device} onClose={() => setEditing(false)} onSaved={setDevice} />}
    </div>
  );
}
