"use client";

import { useState } from "react";
import { ImageOff, ImageUp, Images, Replace } from "lucide-react";
import { getArtifact } from "@/lib/artifacts";
import { imageErrorMessage, imageTitle, isImageArtifact, type ImageArtifact } from "@/lib/images";
import type { Device } from "@/lib/devices";
import { RowActionsMenu } from "@/app/components/ui";
import ChooseProfileImageDialog from "./ChooseProfileImageDialog";
import ProfileAvatar from "./ProfileAvatar";
import ReplaceImageDialog from "./ReplaceImageDialog";
import UploadProfileImageDialog from "./UploadProfileImageDialog";
import type { ProfileImageControls } from "./useProfileImage";
import type { ImageUrls } from "./useImageData";

type Mode = "choose" | "upload" | "replace" | null;

/**
 * The device's profile picture on its page, with what can be done to it:
 *
 * - **Change the picture**: choose another gallery image, or upload a new one
 *   (it joins the gallery) and use it. The previous image stays in the gallery.
 * - **Replace the picture's file**: the gallery's replacement of the current
 *   image's file (same image, new file; the old file is permanently deleted).
 * - **Remove the picture**: the device shows the default icon again; the image
 *   stays in the gallery.
 *
 * Shown to everyone who can see the device; the actions only to those who can
 * edit it (the backend checks the same rule).
 */
export default function DeviceProfilePicture({
  device,
  canEdit,
  urls,
  fileVersion,
  profile,
  onFileReplaced,
  onGalleryChanged,
}: {
  device: Device;
  canEdit: boolean;
  urls: ImageUrls;
  /** Changes whenever the picture's file was replaced, so the avatar reloads. */
  fileVersion: number;
  profile: ProfileImageControls;
  onFileReplaced: (image: ImageArtifact) => void;
  onGalleryChanged: () => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [replacing, setReplacing] = useState<ImageArtifact | null>(null);
  const [opening, setOpening] = useState(false);
  const current = device.profileImageArtifactId;
  const unavailable = !!current && (urls.get(current)?.status === "unavailable" || urls.isBroken(current));

  function open(next: Mode) {
    profile.dismiss();
    setMode(next);
  }

  async function openReplace() {
    if (!current || opening) return;
    profile.dismiss();
    setOpening(true);
    try {
      // The replacement works on the image's current file (its attempt), so
      // the latest record is read rather than anything cached.
      const artifact = await getArtifact(current);
      if (!isImageArtifact(artifact) || artifact.status !== "ready") {
        profile.fail("The profile picture isn't a ready image any more. Choose another picture.");
        return;
      }
      setReplacing(artifact);
      setMode("replace");
    } catch (err) {
      profile.fail(`Couldn't open the profile picture: ${imageErrorMessage(err, "request failed")}`);
    } finally {
      setOpening(false);
    }
  }

  const alt = `Profile picture of ${device.name}`;
  const avatar = (
    <ProfileAvatar
      key={`${current ?? "none"}:${fileVersion}`}
      artifactId={current}
      urls={urls}
      alt={alt}
      size="lg"
      className="border border-line shadow-card"
    />
  );

  return (
    <div className="relative shrink-0">
      {avatar}
      {canEdit && (
        <div className="absolute -bottom-1.5 -right-1.5 rounded-full bg-white shadow-pop border border-line">
          <RowActionsMenu
            label="Profile picture options"
            trigger="button"
            disabled={profile.saving || opening}
            actions={[
              { label: current ? "Change: choose from gallery" : "Choose from gallery", icon: Images, onSelect: () => open("choose") },
              { label: current ? "Change: upload new picture" : "Upload new picture", icon: ImageUp, onSelect: () => open("upload") },
              !!current && !unavailable && { label: "Replace picture file", icon: Replace, onSelect: () => void openReplace() },
              !!current && {
                label: "Remove profile picture",
                icon: ImageOff,
                danger: true,
                onSelect: () =>
                  void profile.setProfile(null, "Removed the profile picture. The image is still in the gallery."),
              },
            ]}
          />
        </div>
      )}

      {mode === "choose" && (
        <ChooseProfileImageDialog
          device={device}
          saving={profile.saving}
          error={profile.error}
          onChoose={(image) => profile.setProfile(image.artifactId, `${imageTitle(image)} is now the profile picture.`)}
          onUploadInstead={() => open("upload")}
          onClose={() => setMode(null)}
        />
      )}
      {mode === "upload" && (
        <UploadProfileImageDialog
          device={device}
          saving={profile.saving}
          error={profile.error}
          onUploaded={(artifactId) => profile.setProfile(artifactId, "Uploaded the new profile picture and selected it.")}
          onGalleryChanged={onGalleryChanged}
          onClose={() => setMode(null)}
        />
      )}
      {mode === "replace" && replacing && (
        <ReplaceImageDialog
          image={replacing}
          urls={urls}
          onClose={() => {
            setMode(null);
            setReplacing(null);
          }}
          onReplaced={(image, cleanupPending) => {
            setMode(null);
            setReplacing(null);
            onFileReplaced(image);
            profile.announce(
              `Replaced the profile picture's file. ${
                cleanupPending
                  ? "The original file couldn't be deleted yet; it will be removed automatically."
                  : "The original file was permanently deleted."
              }`
            );
          }}
        />
      )}
    </div>
  );
}
