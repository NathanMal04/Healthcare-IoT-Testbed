"use client";

import { useEffect, useState } from "react";
import { Check, ImageOff, LoaderCircle } from "lucide-react";
import { formatCapturedAt, imageFileKey, imageTitle, type ImageArtifact } from "@/lib/images";
import type { ImageUrls } from "./useImageData";

/**
 * One image from the cache: a spinner while its URL loads, the image
 * (lazily) once it has one, and a placeholder if it can't be shown. An image
 * that has loaded keeps showing even after its URL expires; one that hasn't
 * loaded yet asks for a fresh URL instead of using a stale one.
 */
export function ImageView({
  image,
  urls,
  className = "",
  fit = "cover",
  lazy = true,
}: {
  image: ImageArtifact;
  urls: ImageUrls;
  className?: string;
  fit?: "cover" | "contain";
  lazy?: boolean;
}) {
  const state = urls.get(image.artifactId);
  const [shownSrc, setShownSrc] = useState<string | null>(null);
  const stale = state?.status === "ready" && state.stale;
  // Only ready images can be viewed; a pending or failed upload has no URL.
  const viewable = image.status === "ready";
  const needsUrl = viewable && !shownSrc && (state === undefined || stale);
  const { ensure } = urls;

  useEffect(() => {
    if (needsUrl) ensure([image.artifactId]);
  }, [needsUrl, ensure, image.artifactId]);

  const src = shownSrc ?? (state?.status === "ready" && !state.stale ? state.url : null);
  const broken = urls.isBroken(image.artifactId) || state?.status === "unavailable";
  const title = imageTitle(image);

  if (!viewable) {
    return (
      <span className={`flex flex-col items-center justify-center gap-1 bg-surface-sunken text-slate-400 ${className}`}>
        <ImageOff className="h-6 w-6" aria-hidden="true" />
        <span className="text-xs" title={image.statusReason ?? undefined}>
          {image.status === "failed" ? "Upload failed" : "Upload not finished"}
        </span>
      </span>
    );
  }
  if (broken && !shownSrc) {
    return (
      <span className={`flex flex-col items-center justify-center gap-1 bg-surface-sunken text-slate-400 ${className}`}>
        <ImageOff className="h-6 w-6" aria-hidden="true" />
        <span className="text-xs">{state?.status === "unavailable" ? state.error : "Can't display this image"}</span>
      </span>
    );
  }
  if (!src) {
    return (
      <span className={`flex items-center justify-center bg-surface-sunken ${className}`} role="status" aria-label={`Loading ${title}`}>
        <LoaderCircle className="h-5 w-5 animate-spin text-brand-500" aria-hidden="true" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs; next/image can't optimise a static export
    <img
      src={src}
      alt={title}
      loading={lazy ? "lazy" : "eager"}
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onLoad={() => setShownSrc(src)}
      onError={() => {
        setShownSrc(null);
        urls.reportError(image.artifactId);
      }}
      className={`${fit === "cover" ? "object-cover" : "object-contain"} bg-surface-sunken ${className}`}
    />
  );
}

/**
 * A responsive grid of image cards. Presentational only, so the device
 * gallery and a future notebook image picker can share it: `renderActions`
 * adds per-image actions (the gallery's edit and download; a later "Set as
 * profile image"), and `selection` turns the cards into toggles for picking.
 */
export function ImageGrid({
  images,
  urls,
  onOpen,
  renderActions,
  selection,
}: {
  images: ImageArtifact[];
  urls: ImageUrls;
  onOpen?: (index: number) => void;
  renderActions?: (image: ImageArtifact, index: number) => React.ReactNode;
  selection?: { selectedIds: ReadonlySet<string>; onToggle: (image: ImageArtifact) => void };
}) {
  return (
    <ul className="grid grid-cols-1 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
      {images.map((image, index) => {
        const title = imageTitle(image);
        const captured = formatCapturedAt(image.capturedAt);
        const selected = selection?.selectedIds.has(image.artifactId) ?? false;
        const activate = () => (selection ? selection.onToggle(image) : onOpen?.(index));
        return (
          <li
            key={image.artifactId}
            className={`group bg-white rounded-xl border shadow-card overflow-hidden flex flex-col ${
              selected ? "border-brand-500 ring-2 ring-brand-500/30" : "border-line"
            }`}
          >
            <button
              type="button"
              onClick={activate}
              aria-label={selection ? `${selected ? "Deselect" : "Select"} ${title}` : `View ${title}`}
              aria-pressed={selection ? selected : undefined}
              className="relative block w-full aspect-[4/3] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-inset"
            >
              {/* Keyed by the file, so a replaced file never keeps showing the old one. */}
              <ImageView key={imageFileKey(image)} image={image} urls={urls} className="absolute inset-0 h-full w-full" />
              {selection && selected && (
                <span className="absolute top-2 right-2 h-6 w-6 rounded-full bg-brand-600 text-white flex items-center justify-center shadow">
                  <Check className="h-4 w-4" aria-hidden="true" />
                </span>
              )}
            </button>
            <div className="p-3 flex-1 flex flex-col gap-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-slate-800 break-words line-clamp-2" title={title}>
                  {title}
                </p>
                {renderActions && <div className="shrink-0 -mr-1 -mt-1">{renderActions(image, index)}</div>}
              </div>
              <p className="text-xs text-slate-500">{captured ? `Captured ${captured}` : "Capture date not set"}</p>
              {image.description && (
                <p className="text-xs text-slate-600 line-clamp-2 whitespace-pre-line break-words" title={image.description}>
                  {image.description}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
