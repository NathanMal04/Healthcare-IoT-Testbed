"use client";

import { Pencil } from "lucide-react";
import type { Device } from "@/lib/devices";
import type { Scope } from "@/lib/workspaces";
import DeviceProfilePicture from "@/app/components/images/DeviceProfilePicture";
import { Alert, Button, PageHeader } from "@/app/components/ui";
import type { DeviceProfilePictureState } from "./useDeviceProfilePicture";

export const DEVICES_BACK = { href: "/devices", label: "Devices" };

/** The device's name, profile picture, type and access, with Edit and the picture's outcome. */
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
  return (
    <>
      <PageHeader
        title={device.name}
        back={DEVICES_BACK}
        scope={scope}
        leading={
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
        }
        description={device.type ? `Device · ${device.type}` : "Device"}
        meta={<span className="text-xs text-slate-500 capitalize">Your access: {device.role}</span>}
        actions={
          <Button variant="secondary" size="sm" icon={Pencil} onClick={onEdit}>
            Edit Device
          </Button>
        }
      />

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
