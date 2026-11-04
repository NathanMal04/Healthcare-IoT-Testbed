"use client";

import { NotebookPen, Pencil } from "lucide-react";
import type { Device } from "@/lib/devices";
import { notebookHref } from "@/lib/routes";
import type { Scope } from "@/lib/workspaces";
import DeviceProfilePicture from "@/app/components/images/DeviceProfilePicture";
import { Alert, Button, ButtonLink, ReStatusBadge, ScopeLabel } from "@/app/components/ui";
import type { DeviceProfilePictureState } from "./useDeviceProfilePicture";

/** "Philips · MX800 · Infusion pump": whichever of the three the device has. */
export function deviceIdentityLine(device: Pick<Device, "manufacturer" | "modelNumber" | "type">): string {
  return [device.manufacturer, device.modelNumber, device.type].filter(Boolean).join(" · ");
}

/**
 * The device's identity: profile picture, name, manufacturer, model and
 * type, its reverse-engineering status, scope and the user's access, with
 * the RE Notebook (the main research destination) and Edit.
 */
export default function DeviceHeader({
  device,
  scope,
  canEdit,
  picture,
  onEdit,
}: {
  device: Device;
  scope: Scope;
  canEdit: boolean;
  picture: DeviceProfilePictureState;
  onEdit: () => void;
}) {
  const { profile } = picture;
  const identity = deviceIdentityLine(device);
  return (
    <>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        {/* Takes the row when there's room; on narrow screens the actions wrap below it. */}
        <div className="flex min-w-0 flex-[1_1_18rem] items-start gap-3 sm:gap-4">
          <DeviceProfilePicture
            device={device}
            canEdit={canEdit}
            urls={picture.urls}
            fileVersion={picture.fileVersion}
            profile={profile}
            onFileReplaced={(image) => {
              picture.refreshFile(image.artifactId);
              // The Images section shows the image too; reload it with the new file.
              picture.reloadGallery();
            }}
            onGalleryChanged={picture.reloadGallery}
          />
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-slate-900 break-words">{device.name}</h1>
            <p className="mt-0.5 text-sm text-slate-500 break-words">{identity || "Device"}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
              <span className="inline-flex items-center">
                <span className="sr-only">Reverse-engineering status: </span>
                <ReStatusBadge status={device.reverseEngineeringStatus} />
              </span>
              <ScopeLabel scope={scope} />
              <span className="text-slate-500">
                Your access: <span className="capitalize">{device.role}</span>
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink href={notebookHref(device.deviceId)} variant="primary" size="sm" icon={NotebookPen}>
            Open RE Notebook
          </ButtonLink>
          {canEdit && (
            <Button variant="secondary" size="sm" icon={Pencil} onClick={onEdit}>
              Edit Device
            </Button>
          )}
        </div>
      </header>

      {profile.notice && (
        <Alert tone="success" className="mb-4" onDismiss={profile.dismiss}>
          {profile.notice}
        </Alert>
      )}
      {profile.error && (
        <Alert tone="error" className="mb-4" onDismiss={profile.dismiss}>
          {profile.error}
        </Alert>
      )}
    </>
  );
}
