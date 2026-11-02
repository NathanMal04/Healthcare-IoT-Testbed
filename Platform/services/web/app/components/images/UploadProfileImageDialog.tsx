"use client";

import { useState } from "react";
import { IMAGE_TYPE } from "@/lib/images";
import type { Device } from "@/lib/devices";
import { useWorkspace } from "@/context/WorkspaceContext";
import ArtifactUploader from "@/app/components/ArtifactUploader";
import { Alert, Button, Dialog } from "@/app/components/ui";

/**
 * Uploads one new picture of the device with the gallery's own uploader (same
 * checks, same storage: it becomes an ordinary gallery image of the device)
 * and, once it is ready, makes it the profile picture.
 *
 * A failed upload changes nothing. An upload that succeeds but can't be set
 * as the picture stays in the gallery, and setting it can be retried here.
 */
export default function UploadProfileImageDialog({
  device,
  saving,
  error,
  onUploaded,
  onGalleryChanged,
  onClose,
}: {
  device: Device;
  saving: boolean;
  error: string | null;
  /** Makes the new image the profile picture; resolves true once saved. */
  onUploaded: (artifactId: string) => Promise<boolean>;
  /** A new image was added to the device's gallery. */
  onGalleryChanged: () => void;
  onClose: () => void;
}) {
  // The uploader locks the scope while it runs.
  const { scopeLocked } = useWorkspace();
  const [uploadedId, setUploadedId] = useState<string | null>(null);
  const busy = scopeLocked || saving;

  async function select(artifactId: string) {
    if (await onUploaded(artifactId)) onClose();
  }

  function close() {
    if (!busy) onClose();
  }

  return (
    <Dialog title="Upload new profile picture" subtitle={device.name} size="xl" onClose={close}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          The picture is added to this device&apos;s gallery and then used as its profile picture. The current picture
          stays in the gallery.
        </p>
        {uploadedId ? (
          <>
            {error ? (
              <Alert
                tone="error"
                action={
                  <button
                    type="button"
                    onClick={() => void select(uploadedId)}
                    disabled={saving}
                    className="text-xs font-medium underline shrink-0"
                  >
                    Try again
                  </button>
                }
              >
                The picture was uploaded and is in the gallery, but it couldn&apos;t be set as the profile picture.{" "}
                {error}
              </Alert>
            ) : (
              <p className="text-sm text-slate-600" role="status">
                {saving ? "Setting the profile picture…" : "Uploaded."}
              </p>
            )}
          </>
        ) : (
          <ArtifactUploader
            devices={[device]}
            fixedDevice={device}
            fixedType={IMAGE_TYPE}
            maxFiles={1}
            onFinished={(_batchId, _failedCount, readyArtifactIds) => {
              // Only a ready upload is used; a failed one leaves the picture as it was.
              const [artifactId] = readyArtifactIds;
              if (!artifactId) return;
              onGalleryChanged();
              setUploadedId(artifactId);
              void select(artifactId);
            }}
          />
        )}
        <div className="flex justify-end pt-2">
          <Button variant="secondary" onClick={close} disabled={busy}>
            {uploadedId && error ? "Close" : "Cancel"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
