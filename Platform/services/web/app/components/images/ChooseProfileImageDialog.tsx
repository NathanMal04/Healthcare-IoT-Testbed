"use client";

import { useMemo, useState } from "react";
import { ImageIcon, ImageUp } from "lucide-react";
import type { ImageArtifact } from "@/lib/images";
import type { Device } from "@/lib/devices";
import { Alert, Button, Dialog, EmptyState, ErrorState, LoadingState } from "@/app/components/ui";
import { ImageGrid } from "./ImageGrid";
import { useDeviceImages, useImageUrls } from "./useImageData";

/**
 * Picks one of the device's ready gallery images as its profile picture.
 * Changing the picture only changes which image the device points at: the
 * previous picture stays in the gallery, and no image is changed.
 */
export default function ChooseProfileImageDialog({
  device,
  saving,
  error,
  onChoose,
  onUploadInstead,
  onClose,
}: {
  device: Device;
  saving: boolean;
  error: string | null;
  /** Resolves true once the device uses the image. */
  onChoose: (image: ImageArtifact) => Promise<boolean>;
  onUploadInstead: () => void;
  onClose: () => void;
}) {
  const { images, hasMore, loading, error: loadError, loadMore, reload } = useDeviceImages(device.deviceId);
  // Only ready images can be shown, so only they can be the picture.
  const ready = useMemo(() => (images ?? []).filter((image) => image.status === "ready"), [images]);
  const urls = useImageUrls(ready.map((image) => image.artifactId));
  const current = device.profileImageArtifactId;
  const [selectedId, setSelectedId] = useState<string | null>(current ?? null);
  const selected = ready.find((image) => image.artifactId === selectedId) ?? null;

  function close() {
    if (!saving) onClose();
  }

  async function choose() {
    if (!selected || selected.artifactId === current || saving) return;
    if (await onChoose(selected)) onClose();
  }

  return (
    <Dialog title="Choose a profile picture" subtitle={device.name} size="2xl" onClose={close}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Pick one of this device&apos;s images. The current picture stays in the gallery; no image is changed or
          deleted.
        </p>

        {loadError && !images?.length ? (
          <ErrorState
            title="Couldn't load images"
            message={loadError}
            action={
              <Button variant="secondary" size="sm" onClick={() => void reload()}>
                Try again
              </Button>
            }
          />
        ) : images === null ? (
          <LoadingState label="Loading images…" />
        ) : ready.length === 0 && !hasMore ? (
          <EmptyState
            icon={ImageIcon}
            title="No images to choose from"
            description="Upload a picture of the device instead; it is added to the gallery too."
            action={
              <Button size="sm" icon={ImageUp} onClick={onUploadInstead}>
                Upload new picture
              </Button>
            }
          />
        ) : (
          <div className="max-h-[55vh] overflow-y-auto pr-1">
            <ImageGrid
              images={ready}
              urls={urls}
              badge={(image) => (image.artifactId === current ? "Current picture" : null)}
              selection={{
                selectedIds: new Set(selectedId ? [selectedId] : []),
                onToggle: (image) => !saving && setSelectedId(image.artifactId),
              }}
            />
            {hasMore && (
              <div className="pt-3 text-center">
                <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loading}>
                  {loading ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </div>
        )}
        {loadError && !!images?.length && <Alert tone="error">{loadError}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}

        <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-2 pt-2">
          <Button variant="secondary" onClick={close} disabled={saving} className="sm:flex-1">
            Cancel
          </Button>
          <Button
            onClick={() => void choose()}
            disabled={!selected || selected.artifactId === current || saving}
            className="sm:flex-1"
          >
            {saving ? "Saving…" : "Use as profile picture"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
