"use client";

import { SquareUserRound } from "lucide-react";
import type { Device } from "@/lib/devices";
import { imageTitle } from "@/lib/images";
import DeviceImageGallery from "@/app/components/images/DeviceImageGallery";
import type { DeviceProfilePictureState } from "../useDeviceProfilePicture";

/** The device's image gallery, where any ready image can become its profile picture. */
export default function ImagesSection({
  device,
  canEdit,
  picture,
}: {
  device: Device;
  canEdit: boolean;
  picture: DeviceProfilePictureState;
}) {
  const { profile } = picture;
  return (
    <DeviceImageGallery
      key={picture.galleryVersion}
      device={device}
      badge={(image) => (image.artifactId === device.profileImageArtifactId ? "Profile picture" : null)}
      extraActions={(image) => [
        canEdit &&
          image.status === "ready" &&
          image.artifactId !== device.profileImageArtifactId && {
            label: "Set as profile picture",
            icon: SquareUserRound,
            disabled: profile.saving,
            onSelect: () => void profile.setProfile(image.artifactId, `${imageTitle(image)} is now the profile picture.`),
          },
      ]}
      onImageReplaced={(image) => {
        // Same image, new file: the header shows the new file without the
        // picture being chosen again.
        if (image.artifactId === device.profileImageArtifactId) picture.refreshFile(image.artifactId);
      }}
    />
  );
}
