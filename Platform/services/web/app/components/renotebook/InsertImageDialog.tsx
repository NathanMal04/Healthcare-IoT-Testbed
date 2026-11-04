"use client";

import { useMemo, useState } from "react";
import { ImageIcon, ImageUp } from "lucide-react";
import { getArtifact } from "@/lib/artifacts";
import type { Device } from "@/lib/devices";
import { IMAGE_TYPE, imageTitle, isImageArtifact, type ImageArtifact } from "@/lib/images";
import { cleanAlt } from "@/lib/reNotebookDoc";
import { ScopeLockReporter } from "@/context/WorkspaceContext";
import ArtifactUploader from "@/app/components/ArtifactUploader";
import { ImageGrid } from "@/app/components/images/ImageGrid";
import { useDeviceImages, useImageUrls } from "@/app/components/images/useImageData";
import { Alert, Button, Dialog, EmptyState, ErrorState, LoadingState, TabPanel, Tabs } from "@/app/components/ui";

export interface InsertedImage {
  artifactId: string;
  /** The image's title (else file name) as alt text; empty when unknown. */
  alt: string;
}

type Tab = "gallery" | "upload";
const TABS: { id: Tab; label: string }[] = [
  { id: "gallery", label: "Device gallery" },
  { id: "upload", label: "Upload new" },
];
const ID_PREFIX = "re-notebook-insert-image-";

/**
 * Inserts one of the device's images into the open entry: picked from its
 * gallery, or uploaded here with the gallery's own uploader (same checks and
 * storage: it becomes an ordinary gallery image of the device). The entry
 * stores only the image's id, so the image stays in the gallery, and editing
 * it there (title, file) shows in the entry too.
 */
export default function InsertImageDialog({
  device,
  onInsert,
  onGalleryChanged,
  onClose,
}: {
  device: Device;
  onInsert: (image: InsertedImage) => void;
  /** A new image was added to the device's gallery (so other views can show it). */
  onGalleryChanged?: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("gallery");
  const [uploading, setUploading] = useState(false);
  const [uploadedId, setUploadedId] = useState<string | null>(null);

  function close() {
    if (!uploading) onClose();
  }

  function insert(image: InsertedImage) {
    onInsert(image);
    onClose();
  }

  /** A new upload is inserted once ready, with its title as alt text if it can be read. */
  async function insertUploaded(artifactId: string) {
    setUploadedId(artifactId);
    onGalleryChanged?.();
    let alt = "";
    try {
      const artifact = await getArtifact(artifactId);
      alt = cleanAlt(isImageArtifact(artifact) ? imageTitle(artifact) : artifact.name);
    } catch {
      // The image is inserted all the same; only its alt text is missing.
    }
    insert({ artifactId, alt });
  }

  return (
    <Dialog title="Insert image" subtitle={device.name} size="2xl" onClose={close}>
      <div className="space-y-4">
        <Tabs tabs={TABS} active={tab} onChange={(next) => !uploading && setTab(next)} ariaLabel="Image source" idPrefix={ID_PREFIX} />
        {tab === "gallery" ? (
          <TabPanel id="gallery" idPrefix={ID_PREFIX} className="pt-1">
            <GalleryPicker device={device} onInsert={insert} onUploadInstead={() => setTab("upload")} onCancel={close} />
          </TabPanel>
        ) : (
          <TabPanel id="upload" idPrefix={ID_PREFIX} className="pt-1 space-y-4">
            <p className="text-sm text-slate-600">
              The image is added to this device&apos;s gallery and then inserted here.
            </p>
            {uploadedId ? (
              <p className="text-sm text-slate-600" role="status">
                Uploaded. Inserting…
              </p>
            ) : (
              <ScopeLockReporter onChange={setUploading}>
                <ArtifactUploader
                  devices={[device]}
                  fixedDevice={device}
                  fixedType={IMAGE_TYPE}
                  maxFiles={1}
                  onFinished={(_batchId, _failedCount, readyArtifactIds) => {
                    // Only a ready upload is inserted; a failed one changes nothing.
                    const [artifactId] = readyArtifactIds;
                    if (artifactId) void insertUploaded(artifactId);
                  }}
                />
              </ScopeLockReporter>
            )}
            <div className="flex justify-end pt-2">
              <Button variant="secondary" onClick={close} disabled={uploading}>
                Cancel
              </Button>
            </div>
          </TabPanel>
        )}
      </div>
    </Dialog>
  );
}

function GalleryPicker({
  device,
  onInsert,
  onUploadInstead,
  onCancel,
}: {
  device: Device;
  onInsert: (image: InsertedImage) => void;
  onUploadInstead: () => void;
  onCancel: () => void;
}) {
  const { images, hasMore, loading, error, loadMore, reload } = useDeviceImages(device.deviceId);
  // Only ready images can be shown, so only they can be inserted.
  const ready = useMemo(() => (images ?? []).filter((image) => image.status === "ready"), [images]);
  const urls = useImageUrls(ready.map((image) => image.artifactId));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected: ImageArtifact | null = ready.find((image) => image.artifactId === selectedId) ?? null;

  return (
    <div className="space-y-4">
      {error && !images?.length ? (
        <ErrorState
          title="Couldn't load images"
          message={error}
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
          title="No images of this device yet"
          description="Upload one; it is added to the device's gallery too."
          action={
            <Button size="sm" icon={ImageUp} onClick={onUploadInstead}>
              Upload new image
            </Button>
          }
        />
      ) : (
        <div className="max-h-[55vh] overflow-y-auto pr-1">
          <ImageGrid
            images={ready}
            urls={urls}
            selection={{
              selectedIds: new Set(selectedId ? [selectedId] : []),
              onToggle: (image) => setSelectedId(image.artifactId),
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
      {error && !!images?.length && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel} className="sm:flex-1">
          Cancel
        </Button>
        <Button
          onClick={() => selected && onInsert({ artifactId: selected.artifactId, alt: cleanAlt(imageTitle(selected)) })}
          disabled={!selected}
          className="sm:flex-1"
        >
          Insert image
        </Button>
      </div>
    </div>
  );
}
