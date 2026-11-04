"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { ImageOff, LoaderCircle, RotateCw } from "lucide-react";
import { useImageUrls, type ImageUrls } from "@/app/components/images/useImageData";

// Images in notebook documents. A document holds an image's artifactId only;
// these components get it a short-lived view URL from the gallery's URL
// cache (lib/images.ts) when it is shown, so nothing but the id is stored.

interface NotebookImagesValue {
  urls: ImageUrls;
  /** Load every image right away (export), rather than as it scrolls into view. */
  eager: boolean;
}

const NotebookImagesContext = createContext<NotebookImagesValue | null>(null);

const NO_IDS: string[] = [];

/**
 * One view-URL cache for the documents below it: the open entry, the
 * read-only views and the conflict dialog share it, so an image shown twice
 * costs one URL. `artifactIds` are fetched up front (the export knows them
 * all); otherwise each image asks for its own as it is shown.
 */
export function NotebookImagesProvider({
  artifactIds = NO_IDS,
  eager = false,
  children,
}: {
  artifactIds?: string[];
  eager?: boolean;
  children: React.ReactNode;
}) {
  const urls = useImageUrls(artifactIds);
  return <NotebookImagesContext.Provider value={{ urls, eager }}>{children}</NotebookImagesContext.Provider>;
}

/** How an image is doing, on its element as data-image-state (the export waits for none to be "loading"). */
export type NotebookImageState = "loading" | "ready" | "error";

/** The editor's node view for images (see NotebookImage in lib/reNotebookEditor.ts). */
function NotebookImageView({ node, selected }: ReactNodeViewProps) {
  const artifactId = typeof node.attrs.artifactId === "string" ? node.attrs.artifactId : "";
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const images = useContext(NotebookImagesContext);
  return (
    <NodeViewWrapper
      as="figure"
      data-drag-handle=""
      className={`re-notebook-image ${selected ? "is-selected" : ""}`}
    >
      {images && artifactId ? (
        <NotebookImageBody artifactId={artifactId} alt={alt} urls={images.urls} eager={images.eager} />
      ) : (
        <Placeholder state="error" alt={alt} message="Image unavailable" />
      )}
    </NodeViewWrapper>
  );
}

export const notebookImageNodeView = ReactNodeViewRenderer(NotebookImageView);

/**
 * Mirrors the gallery's ImageView: a spinner while the URL loads, the image
 * once it has one, and a placeholder if it can't be shown (deleted, no
 * longer the caller's to see, or a file that won't load). An image that has
 * loaded keeps showing after its URL expires; one that fails to load with an
 * old URL gets one fresh URL before it counts as broken.
 */
function NotebookImageBody({
  artifactId,
  alt,
  urls,
  eager,
}: {
  artifactId: string;
  alt: string;
  urls: ImageUrls;
  eager: boolean;
}) {
  const state = urls.get(artifactId);
  const [shownSrc, setShownSrc] = useState<string | null>(null);
  const stale = state?.status === "ready" && state.stale;
  const needsUrl = !shownSrc && (state === undefined || stale);
  const { ensure } = urls;

  useEffect(() => {
    if (needsUrl) ensure([artifactId]);
  }, [needsUrl, ensure, artifactId]);

  const src = shownSrc ?? (state?.status === "ready" && !state.stale ? state.url : null);
  const broken = urls.isBroken(artifactId) || state?.status === "unavailable";
  const retry = () => {
    setShownSrc(null);
    urls.refresh(artifactId);
  };

  if (broken && !shownSrc) {
    const message = state?.status === "unavailable" ? state.error : "Can't display this image";
    return <Placeholder state="error" alt={alt} message={message} onRetry={retry} />;
  }
  if (!src && state === undefined && urls.error) {
    // The whole view-URL request failed (offline, expired session).
    return <Placeholder state="error" alt={alt} message={urls.error} onRetry={retry} />;
  }
  if (!src) return <Placeholder state="loading" alt={alt} message="Loading image…" />;
  return (
    <span className="re-notebook-image-frame" data-notebook-image-state={shownSrc ? "ready" : "loading"}>
      {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs; next/image can't optimise a static export */}
      <img
        src={src}
        alt={alt || "Device image"}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        onLoad={() => setShownSrc(src)}
        onError={() => {
          setShownSrc(null);
          urls.reportError(artifactId);
        }}
      />
    </span>
  );
}

function Placeholder({
  state,
  alt,
  message,
  onRetry,
}: {
  state: Exclude<NotebookImageState, "ready">;
  alt: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <span
      className="re-notebook-image-placeholder"
      data-notebook-image-state={state}
      role={state === "loading" ? "status" : undefined}
      aria-label={state === "loading" ? `Loading ${alt || "image"}` : undefined}
    >
      {state === "loading" ? (
        <LoaderCircle className="h-5 w-5 animate-spin text-brand-500" aria-hidden="true" />
      ) : (
        <>
          <ImageOff className="h-6 w-6" aria-hidden="true" />
          <span className="text-xs">
            {message}
            {alt && <span className="block text-slate-500">{alt}</span>}
          </span>
          {onRetry && (
            <button
              type="button"
              contentEditable={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onRetry}
              className="re-notebook-image-retry inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
            >
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
              Try again
            </button>
          )}
        </>
      )}
    </span>
  );
}
