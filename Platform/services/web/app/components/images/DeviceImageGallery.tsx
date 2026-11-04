"use client";

import { useState } from "react";
import { Download, ImageIcon, Maximize2, Pencil, RefreshCw, Replace, Upload } from "lucide-react";
import { getArtifactDownloadUrl } from "@/lib/artifacts";
import { IMAGE_TYPE, imageErrorMessage, imageTitle, type ImageArtifact } from "@/lib/images";
import { canEditDevice, type Device } from "@/lib/devices";
import { useWorkspace } from "@/context/WorkspaceContext";
import ArtifactUploader from "@/app/components/ArtifactUploader";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  RowActionsMenu,
  type RowAction,
} from "@/app/components/ui";
import EditImageDialog from "./EditImageDialog";
import ReplaceImageDialog from "./ReplaceImageDialog";
import { ImageGrid } from "./ImageGrid";
import ImageLightbox from "./ImageLightbox";
import { useDeviceImages, useImageUrls } from "./useImageData";

/**
 * A device's photographs: upload (the shared uploader, fixed to this device
 * and to images, so uploads land in the device's scope), a paged grid, a
 * full-size viewer, metadata editing and replacing an image's file.
 *
 * `extraActions` adds per-image actions to the card menu (the device page's
 * "Set as profile picture"), and `badge` labels a card (its current one).
 */
export default function DeviceImageGallery({
  device,
  extraActions,
  badge,
  onImageReplaced,
}: {
  device: Device;
  extraActions?: (image: ImageArtifact) => (RowAction | false | null | undefined)[];
  /** A label on an image's card, e.g. which image is the device's profile picture. */
  badge?: (image: ImageArtifact) => React.ReactNode;
  /** An image's file was replaced here (same artifact, new file). */
  onImageReplaced?: (image: ImageArtifact) => void;
}) {
  // The uploader locks the scope while it runs, so it can't be closed mid-upload.
  const { scopeLocked } = useWorkspace();
  const { images, hasMore, loading, error, loadMore, reload, replace } = useDeviceImages(device.deviceId);
  const urls = useImageUrls((images ?? []).filter((image) => image.status === "ready").map((image) => image.artifactId));

  // Viewers see, open and download images; only contributors change them.
  const canEdit = canEditDevice(device);
  const [uploading, setUploading] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState<ImageArtifact | null>(null);
  const [replacing, setReplacing] = useState<ImageArtifact | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function download(image: ImageArtifact) {
    // The original file, as an attachment (GET /artifacts/{id}/download).
    window.location.assign(await getArtifactDownloadUrl(image.artifactId));
  }

  async function downloadFromCard(image: ImageArtifact) {
    setActionError(null);
    try {
      await download(image);
    } catch (err) {
      setActionError(`Couldn't download ${imageTitle(image)}: ${imageErrorMessage(err, "Download failed")}`);
    }
  }

  function openEditor(image: ImageArtifact) {
    setNotice(null);
    setActionError(null);
    setEditing(image);
  }

  function openReplace(image: ImageArtifact) {
    setNotice(null);
    setActionError(null);
    setReplacing(image);
  }

  function onReplaced(updated: ImageArtifact, cleanupPending: boolean) {
    // Same artifact, new file: update it in place (keeping the loaded pages
    // and the viewer's position) and drop its cached URL, which points at
    // the old file. The image views are keyed by the file, so they reload.
    replace(updated);
    urls.refresh(updated.artifactId);
    setReplacing(null);
    onImageReplaced?.(updated);
    setNotice(
      `Replaced the file of ${imageTitle(updated)}. ` +
        (cleanupPending
          ? "The original file couldn't be deleted yet; it will be removed automatically."
          : "The original file was permanently deleted.")
    );
  }

  const uploadButton = canEdit ? (
    <Button size="sm" icon={Upload} onClick={() => setUploading(true)}>
      Upload images
    </Button>
  ) : null;

  return (
    <div className="space-y-4">
      {uploading && (
        <ArtifactUploader
          devices={[device]}
          fixedDevice={device}
          fixedType={IMAGE_TYPE}
          onFinished={(uploadBatchId, failedCount) => {
            void reload();
            // With failures the uploader stays, so they can be reviewed or retried.
            if (uploadBatchId && failedCount === 0) {
              setUploading(false);
              setNotice("Images uploaded.");
            }
          }}
        />
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title="Images"
          description="Photographs of this device: boards, chips, labels and teardown steps"
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                onClick={() => void reload()}
                disabled={loading}
                aria-label="Refresh images"
              >
                Refresh
              </Button>
              {uploading ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setUploading(false)}
                  disabled={scopeLocked}
                  title={scopeLocked ? "Cancel the running upload first" : undefined}
                >
                  Close uploader
                </Button>
              ) : (
                uploadButton
              )}
            </>
          }
        />
        {notice && (
          <Alert tone="success" className="mx-5 mt-3" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        )}
        {actionError && (
          <Alert tone="error" className="mx-5 mt-3" onDismiss={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}
        {(urls.error || urls.problemCount > 0) && (
          <Alert
            tone="warning"
            className="mx-5 mt-3"
            action={
              <button type="button" onClick={urls.retry} className="text-xs font-medium underline shrink-0">
                Try again
              </button>
            }
          >
            {urls.error ??
              `${urls.problemCount} image${urls.problemCount === 1 ? "" : "s"} couldn't be displayed.`}
          </Alert>
        )}

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
        ) : images.length === 0 ? (
          <EmptyState
            icon={ImageIcon}
            title="No images for this device yet"
            description={
              canEdit ? "Upload JPEG, PNG or WebP photographs of the device, its boards and components." : undefined
            }
            action={uploading || !uploadButton ? undefined : uploadButton}
          />
        ) : (
          <div className="p-4 sm:p-5">
            <ImageGrid
              images={images}
              urls={urls}
              onOpen={setViewerIndex}
              badge={badge}
              renderActions={(image, index) => (
                <RowActionsMenu
                  label={`Actions for ${imageTitle(image)}`}
                  actions={[
                    { label: "View full size", icon: Maximize2, onSelect: () => setViewerIndex(index) },
                    canEdit && { label: "Edit details", icon: Pencil, onSelect: () => openEditor(image) },
                    canEdit &&
                      image.status === "ready" && { label: "Replace image", icon: Replace, onSelect: () => openReplace(image) },
                    { label: "Download original", icon: Download, onSelect: () => void downloadFromCard(image) },
                    ...(extraActions?.(image) ?? []),
                  ]}
                />
              )}
            />
          </div>
        )}

        {images && images.length > 0 && error && (
          <Alert tone="error" className="mx-5 mb-3">
            {error}
          </Alert>
        )}
        {hasMore && images && images.length > 0 && (
          <div className="px-5 py-3 border-t border-line text-center">
            <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </Card>

      {/* The lightbox steps aside while its image is edited or replaced, so Escape closes only the dialog. */}
      {viewerIndex !== null && images && !editing && !replacing && (
        <ImageLightbox
          images={images}
          index={Math.min(viewerIndex, images.length - 1)}
          hasMore={hasMore}
          urls={urls}
          onIndexChange={setViewerIndex}
          onLoadMore={loadMore}
          loadError={error}
          onClose={() => setViewerIndex(null)}
          onEdit={canEdit ? openEditor : undefined}
          onReplace={canEdit ? openReplace : undefined}
          onDownload={download}
        />
      )}
      {editing && (
        <EditImageDialog
          image={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            replace(updated);
            setEditing(null);
            // The PATCH response is the saved record; replacing it in place
            // keeps the loaded pages and the viewer's position.
            setNotice(`Saved the details of ${imageTitle(updated)}.`);
          }}
        />
      )}
      {replacing && (
        <ReplaceImageDialog image={replacing} urls={urls} onClose={() => setReplacing(null)} onReplaced={onReplaced} />
      )}
    </div>
  );
}
