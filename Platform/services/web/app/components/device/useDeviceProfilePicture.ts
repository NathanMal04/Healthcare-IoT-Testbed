"use client";

import { useCallback, useState } from "react";
import type { Device } from "@/lib/devices";
import { useImageUrls, type ImageUrls } from "@/app/components/images/useImageData";
import { useProfileImage, type ProfileImageControls } from "@/app/components/images/useProfileImage";

export interface DeviceProfilePictureState {
  /** The picture's view URL. */
  urls: ImageUrls;
  /** Bumped when the picture's file is replaced, so it is shown afresh. */
  fileVersion: number;
  /** Bumped to reload the Images section (e.g. after an upload from the header). */
  galleryVersion: number;
  profile: ProfileImageControls;
  /** The picture's file was replaced: fetch its new view URL and show it. */
  refreshFile: (artifactId: string) => void;
  reloadGallery: () => void;
}

/** The device's profile picture, shared by the header and the Images section. */
export function useDeviceProfilePicture(
  device: Device | null,
  updateDevice: (update: (current: Device) => Device) => void
): DeviceProfilePictureState {
  const profileImageId = device?.profileImageArtifactId;
  const urls = useImageUrls(profileImageId ? [profileImageId] : []);
  const [fileVersion, setFileVersion] = useState(0);
  const [galleryVersion, setGalleryVersion] = useState(0);
  const profile = useProfileImage(device?.deviceId, updateDevice);

  const refreshFile = useCallback(
    (artifactId: string) => {
      urls.refresh(artifactId);
      setFileVersion((v) => v + 1);
    },
    [urls]
  );
  const reloadGallery = useCallback(() => setGalleryVersion((v) => v + 1), []);

  return { urls, fileVersion, galleryVersion, profile, refreshFile, reloadGallery };
}
