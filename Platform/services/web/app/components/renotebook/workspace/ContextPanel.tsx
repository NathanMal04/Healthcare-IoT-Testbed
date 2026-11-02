"use client";

import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { Download, FileArchive, ImageIcon, LoaderCircle, X } from "lucide-react";
import {
  ARTIFACT_TYPES,
  ARTIFACT_TYPE_LABELS,
  formatBytes,
  getArtifactDownloadUrl,
  listDeviceArtifacts,
  type Artifact,
  type ArtifactType,
} from "@/lib/artifacts";
import type { Device } from "@/lib/devices";
import { imageTitle, isImageArtifact, type ImageArtifact } from "@/lib/images";
import { ImageView } from "@/app/components/images/ImageGrid";
import ImageLightbox from "@/app/components/images/ImageLightbox";
import { useDeviceImages, useImageUrls, type ImageUrls } from "@/app/components/images/useImageData";
import { Alert, Button, formatDay, selectClass } from "@/app/components/ui";

const ARTIFACT_PAGE_SIZE = 25;

/**
 * Starts a download without leaving the page: the notebook may have unsaved
 * changes, and navigating to the file would ask whether to leave. The
 * download URL is short-lived and sent as an attachment.
 */
function downloadInBackground(url: string) {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.setAttribute("aria-hidden", "true");
  frame.src = url;
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), 60_000);
}

/**
 * The device's own files beside the notebook: its artifacts and its image
 * gallery, read-only. Both come from the existing device APIs (nothing is
 * copied); images show through short-lived view URLs, and artifacts can be
 * downloaded. Linking them into entries comes later.
 */
const ContextPanel = forwardRef<
  HTMLHeadingElement,
  { device: Device; onClose?: () => void }
>(function ContextPanel({ device, onClose }, headingRef) {
  const gallery = useDeviceImages(device.deviceId);
  const urls = useImageUrls((gallery.images ?? []).filter((i) => i.status === "ready").map((i) => i.artifactId));
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const download = useCallback(async (artifact: Artifact) => {
    setDownloadError(null);
    try {
      downloadInBackground(await getArtifactDownloadUrl(artifact.artifactId));
    } catch (err) {
      setDownloadError(`Couldn't download ${artifact.name}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 text-sm font-semibold text-slate-900 outline-none">
          Device context
        </h2>
        {onClose && (
          <button
            type="button"
            aria-label="Close the device context panel"
            onClick={onClose}
            className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg text-slate-500 hover:bg-surface-sunken hover:text-slate-900"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-line">
        {downloadError && (
          <div className="p-3">
            <Alert onDismiss={() => setDownloadError(null)}>{downloadError}</Alert>
          </div>
        )}
        <ArtifactsSection device={device} urls={urls} onDownload={download} />
        <ImagesSection
          device={device}
          images={gallery.images}
          hasMore={gallery.hasMore}
          loading={gallery.loading}
          error={gallery.error}
          urls={urls}
          onLoadMore={() => void gallery.loadMore()}
          onRetry={() => void gallery.reload()}
          onOpen={setViewerIndex}
        />
      </div>

      {viewerIndex !== null && gallery.images && gallery.images[viewerIndex] && (
        <ImageLightbox
          images={gallery.images}
          index={viewerIndex}
          hasMore={gallery.hasMore}
          urls={urls}
          onIndexChange={setViewerIndex}
          onLoadMore={gallery.loadMore}
          loadError={gallery.error}
          onClose={() => setViewerIndex(null)}
          onDownload={download}
        />
      )}
    </div>
  );
});

export default ContextPanel;

function SectionHeading({ id, children, count }: { id: string; children: React.ReactNode; count?: string }) {
  return (
    <h3 id={id} className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
      {count && <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-2xs font-medium tabular-nums normal-case text-slate-500">{count}</span>}
    </h3>
  );
}

function ArtifactsSection({
  device,
  urls,
  onDownload,
}: {
  device: Device;
  urls: ImageUrls;
  onDownload: (artifact: Artifact) => Promise<void>;
}) {
  const [type, setType] = useState<ArtifactType | "">("");
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the latest load may update the list (a type change overtakes "load more").
  const loadIdRef = useRef(0);

  const load = useCallback(
    async (token?: string) => {
      const loadId = ++loadIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const page = await listDeviceArtifacts(device.deviceId, {
          type: type || undefined,
          limit: ARTIFACT_PAGE_SIZE,
          nextToken: token,
        });
        if (loadId !== loadIdRef.current) return;
        setArtifacts((current) => (token && current ? [...current, ...page.artifacts] : page.artifacts));
        setNextToken(page.nextToken);
      } catch (err) {
        if (loadId === loadIdRef.current) setError(err instanceof Error ? err.message : "Couldn't load artifacts");
      } finally {
        if (loadId === loadIdRef.current) setLoading(false);
      }
    },
    [device.deviceId, type]
  );

  useEffect(() => {
    setArtifacts(null);
    void load();
    const loadIds = loadIdRef;
    return () => {
      loadIds.current++;
    };
  }, [load]);

  return (
    <section aria-labelledby="re-notebook-artifacts" className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading id="re-notebook-artifacts" count={artifacts ? `${artifacts.length}${nextToken ? "+" : ""}` : undefined}>
          Artifacts
        </SectionHeading>
        <label className="sr-only" htmlFor="re-notebook-artifact-type">
          Artifact type
        </label>
        <select
          id="re-notebook-artifact-type"
          value={type}
          onChange={(e) => setType(e.target.value as ArtifactType | "")}
          className={`${selectClass} !h-8 !w-auto !py-0 text-xs`}
        >
          <option value="">All types</option>
          {ARTIFACT_TYPES.map((t) => (
            <option key={t} value={t}>
              {ARTIFACT_TYPE_LABELS[t].category}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <Alert
          action={
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {error}
        </Alert>
      )}
      {!artifacts && !error && <PanelLoading label="Loading artifacts…" />}
      {artifacts && artifacts.length === 0 && (
        <p className="text-sm text-slate-500">
          {type ? `No ${ARTIFACT_TYPE_LABELS[type].category.toLowerCase()} for this device.` : "No artifacts for this device yet."}
        </p>
      )}
      {artifacts && artifacts.length > 0 && (
        <ul className="-mx-1 space-y-0.5" aria-labelledby="re-notebook-artifacts">
          {artifacts.map((artifact) => (
            <ArtifactRow key={artifact.artifactId} artifact={artifact} urls={urls} onDownload={onDownload} />
          ))}
        </ul>
      )}
      {nextToken && artifacts && (
        <Button size="sm" variant="secondary" className="w-full" disabled={loading} onClick={() => void load(nextToken)}>
          {loading ? "Loading…" : "Load more artifacts"}
        </Button>
      )}
    </section>
  );
}

function ArtifactRow({
  artifact,
  urls,
  onDownload,
}: {
  artifact: Artifact;
  urls: ImageUrls;
  onDownload: (artifact: Artifact) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const ready = artifact.status === "ready";
  const name = isImageArtifact(artifact) ? imageTitle(artifact) : artifact.name;
  return (
    <li className="flex items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-surface-muted">
      {isImageArtifact(artifact) && ready ? (
        <ImageView image={artifact} urls={urls} className="h-11 w-11 shrink-0 rounded-md border border-line" />
      ) : (
        <span className="h-11 w-11 shrink-0 rounded-md border border-line bg-brand-50 text-brand-600 flex items-center justify-center" aria-hidden="true">
          {artifact.type === "image" ? <ImageIcon className="h-5 w-5" /> : <FileArchive className="h-5 w-5" />}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-slate-800" title={artifact.originalFilename || name}>
          {name}
        </span>
        <span className="block truncate text-xs text-slate-500">
          {ARTIFACT_TYPE_LABELS[artifact.type]?.single ?? artifact.type} · {formatBytes(artifact.sizeBytes)} ·{" "}
          {ready ? formatDay(artifact.uploadedAt ?? artifact.createdAt) : artifact.status === "failed" ? "Upload failed" : "Uploading"}
        </span>
      </span>
      {ready && (
        <button
          type="button"
          aria-label={`Download ${name}`}
          title="Download"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onDownload(artifact);
            setBusy(false);
          }}
          className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg text-slate-500 hover:bg-surface-sunken hover:text-slate-900 disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
        </button>
      )}
    </li>
  );
}

function ImagesSection({
  device,
  images,
  hasMore,
  loading,
  error,
  urls,
  onLoadMore,
  onRetry,
  onOpen,
}: {
  device: Device;
  images: ImageArtifact[] | null;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  urls: ImageUrls;
  onLoadMore: () => void;
  onRetry: () => void;
  onOpen: (index: number) => void;
}) {
  return (
    <section aria-labelledby="re-notebook-images" className="p-4 space-y-3">
      <SectionHeading id="re-notebook-images" count={images ? `${images.length}${hasMore ? "+" : ""}` : undefined}>
        Device images
      </SectionHeading>
      {error && (
        <Alert
          action={
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          }
        >
          {error}
        </Alert>
      )}
      {urls.error && <Alert tone="warning">{urls.error}</Alert>}
      {!images && !error && <PanelLoading label="Loading images…" />}
      {images && images.length === 0 && <p className="text-sm text-slate-500">No images of this device yet.</p>}
      {images && images.length > 0 && (
        <ul className="grid grid-cols-3 gap-2" aria-labelledby="re-notebook-images">
          {images.map((image, index) => {
            const profile = image.artifactId === device.profileImageArtifactId;
            const title = imageTitle(image);
            return (
              <li key={image.artifactId} className="relative">
                <button
                  type="button"
                  onClick={() => onOpen(index)}
                  aria-label={`View ${title}${profile ? " (profile picture)" : ""}`}
                  title={title}
                  className={`block w-full overflow-hidden rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    profile ? "border-brand-500 ring-1 ring-brand-500" : "border-line hover:border-line-strong"
                  }`}
                >
                  <ImageView image={image} urls={urls} className="aspect-square w-full" />
                </button>
                {profile && (
                  <span className="pointer-events-none absolute inset-x-1 bottom-1 rounded bg-brand-600 px-1 py-0.5 text-center text-2xs font-medium text-white">
                    Profile
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && images && (
        <Button size="sm" variant="secondary" className="w-full" disabled={loading} onClick={onLoadMore}>
          {loading ? "Loading…" : "Load more images"}
        </Button>
      )}
    </section>
  );
}

function PanelLoading({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-slate-500" role="status">
      <LoaderCircle className="h-4 w-4 animate-spin text-brand-500" aria-hidden="true" />
      {label}
    </p>
  );
}
