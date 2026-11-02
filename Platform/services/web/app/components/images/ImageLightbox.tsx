"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, LoaderCircle, Pencil, Replace } from "lucide-react";
import { formatBytes } from "@/lib/artifacts";
import { formatCapturedAt, imageFileKey, imageTitle, lightboxStep, type ImageArtifact } from "@/lib/images";
import { Alert, Button, Dialog, formatDate } from "@/app/components/ui";
import { ImageView } from "./ImageGrid";
import type { ImageUrls } from "./useImageData";

/**
 * A large view of one image with previous/next navigation over the images
 * loaded so far. Moving past the last loaded image loads the next page
 * first (`onLoadMore`), so the viewer works with a paginated gallery.
 * Arrow keys navigate; Escape closes (the Dialog's own handling).
 */
export default function ImageLightbox({
  images,
  index,
  hasMore,
  urls,
  onIndexChange,
  onLoadMore,
  loadError,
  onClose,
  onEdit,
  onReplace,
  onDownload,
}: {
  images: ImageArtifact[];
  index: number;
  hasMore: boolean;
  urls: ImageUrls;
  onIndexChange: (index: number) => void;
  onLoadMore: () => Promise<boolean>;
  /** The gallery's last loading error, shown here after the viewer tried to load the next page. */
  loadError?: string | null;
  onClose: () => void;
  onEdit?: (image: ImageArtifact) => void;
  /** Replaces the image's file (ready images only). */
  onReplace?: (image: ImageArtifact) => void;
  onDownload?: (image: ImageArtifact) => Promise<void>;
}) {
  const [loadingMore, setLoadingMore] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Set when moving past the last loaded image needed the next page.
  const [triedMore, setTriedMore] = useState(false);
  const image = images[index];

  const step = useCallback(
    async (delta: -1 | 1) => {
      if (loadingMore) return;
      const next = lightboxStep(index, delta, images.length, hasMore);
      setDownloadError(null);
      setTriedMore(false);
      if (next.kind === "show") onIndexChange(next.index);
      else if (next.kind === "load-more") {
        setLoadingMore(true);
        try {
          if (await onLoadMore()) onIndexChange(index + 1);
          else setTriedMore(true);
        } finally {
          setLoadingMore(false);
        }
      }
    },
    [index, images.length, hasMore, loadingMore, onIndexChange, onLoadMore]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Not while typing somewhere (the lightbox has no inputs, but be safe).
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        void step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        void step(1);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step]);

  if (!image) return null;

  const title = imageTitle(image);
  const captured = formatCapturedAt(image.capturedAt);
  const canPrev = index > 0;
  const canNext = index < images.length - 1 || hasMore;
  const position = `${index + 1} of ${images.length}${hasMore ? "+" : ""}`;

  async function download() {
    if (!onDownload) return;
    setDownloadError(null);
    try {
      await onDownload(image);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Download failed");
    }
  }

  const navButton =
    "absolute top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-white/90 hover:bg-white text-slate-700 shadow-pop border border-line flex items-center justify-center disabled:opacity-0 disabled:pointer-events-none";

  return (
    <Dialog title={title} subtitle={position} size="full" onClose={onClose}>
      <div className="space-y-4">
        <div className="relative rounded-lg bg-navy-950 overflow-hidden flex items-center justify-center h-[50vh] sm:h-[62vh]">
          {/* Keyed by the file, so neither another image nor a replaced file briefly shows the old one. */}
          <ImageView key={imageFileKey(image)} image={image} urls={urls} fit="contain" lazy={false} className="h-full w-full bg-navy-950" />
          <button type="button" onClick={() => void step(-1)} disabled={!canPrev || loadingMore} aria-label="Previous image" className={`${navButton} left-2 sm:left-3`}>
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => void step(1)} disabled={!canNext || loadingMore} aria-label={loadingMore ? "Loading more images" : "Next image"} className={`${navButton} right-2 sm:right-3`}>
            {loadingMore ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> : <ChevronRight className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>

        <div className="flex flex-col md:flex-row md:items-start gap-4">
          <div className="flex-1 min-w-0 space-y-2">
            <p className="text-sm text-slate-700">
              {captured ? (
                <>
                  <span className="text-slate-500">Captured</span> {captured}
                </>
              ) : (
                <span className="text-slate-400">Capture date not set</span>
              )}
            </p>
            {image.description ? (
              <p className="text-sm text-slate-700 whitespace-pre-line break-words">{image.description}</p>
            ) : (
              <p className="text-sm text-slate-400">No description</p>
            )}
            <p className="text-xs text-slate-400 break-all">
              {image.originalFilename} · {image.mimeType.replace("image/", "").toUpperCase()} · {formatBytes(image.sizeBytes)} ·
              Uploaded {formatDate(image.uploadedAt ?? image.createdAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
            {onEdit && (
              <Button variant="secondary" size="sm" icon={Pencil} onClick={() => onEdit(image)}>
                Edit details
              </Button>
            )}
            {onReplace && image.status === "ready" && (
              <Button variant="secondary" size="sm" icon={Replace} onClick={() => onReplace(image)}>
                Replace image
              </Button>
            )}
            {onDownload && (
              <Button variant="secondary" size="sm" icon={Download} onClick={() => void download()}>
                Download original
              </Button>
            )}
          </div>
        </div>
        {triedMore && loadError && <Alert tone="error">Couldn&apos;t load more images: {loadError}</Alert>}
        {(urls.isBroken(image.artifactId) || urls.get(image.artifactId)?.status === "unavailable") && (
          <Alert
            tone="warning"
            action={
              <button type="button" onClick={urls.retry} className="text-xs font-medium underline shrink-0">
                Try again
              </button>
            }
          >
            This image couldn&apos;t be displayed.
          </Alert>
        )}
        {downloadError && <Alert tone="error">Couldn&apos;t download: {downloadError}</Alert>}
        <p className="sr-only" aria-live="polite">
          {title}, image {position}
        </p>
      </div>
    </Dialog>
  );
}
