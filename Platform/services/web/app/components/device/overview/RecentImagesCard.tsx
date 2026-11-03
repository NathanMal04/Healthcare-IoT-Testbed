"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ImageOff, Images } from "lucide-react";
import { countDescription, countText, pageCount, previewImages } from "@/lib/deviceOverview";
import { imageTitle, type ImageArtifact } from "@/lib/images";
import { useImageUrls } from "@/app/components/images/useImageData";
import { Button, ButtonLink, Card, CardHeader, Skeleton, SkeletonText, focusRing } from "@/app/components/ui";
import type { Loadable } from "../useOverviewData";

const SHOWN = 4;

/**
 * The newest images of the device, through the same short-lived view URLs
 * as the gallery. Each opens the Images section; images that aren't ready
 * (or whose preview can't be shown) say so instead of breaking.
 */
export default function RecentImagesCard({
  images,
  imagesHref,
}: {
  images: Loadable<{ images: ImageArtifact[]; nextToken?: string }>;
  imagesHref: string;
}) {
  const page = images.data;
  const ready = useMemo(() => previewImages((page?.images ?? []).filter((i) => i.status === "ready"), SHOWN), [page]);
  const ids = useMemo(() => ready.map((i) => i.artifactId), [ready]);
  const urls = useImageUrls(ids);
  const count = page ? pageCount(page.images, page.nextToken) : null;

  return (
    <Card>
      <CardHeader
        title="Recent images"
        description={count ? `${countText(count)} ${count.value === 1 && count.exact ? "image" : "images"}` : undefined}
        actions={
          <ButtonLink href={imagesHref} variant="secondary" size="sm">
            View all
          </ButtonLink>
        }
      />
      <div className="p-5">
        {images.error && !page ? (
          <div className="space-y-2">
            <p className="text-meta text-danger-700">{images.error}</p>
            <Button variant="secondary" size="sm" onClick={images.reload} disabled={images.loading}>
              {images.loading ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : !page ? (
          <SkeletonText lines={2} />
        ) : page.images.length === 0 ? (
          <div className="flex items-start gap-3">
            <Images className="mt-0.5 h-5 w-5 shrink-0 text-slate-300" aria-hidden="true" />
            <p className="text-sm text-slate-500">No images of this device yet.</p>
          </div>
        ) : (
          <>
            {count && !count.exact && <p className="sr-only">{countDescription(count)} images</p>}
            {ready.length === 0 ? (
              <p className="text-sm text-slate-500">None of the newest images is ready to preview yet.</p>
            ) : (
              <ul className="grid grid-cols-4 gap-2">
                {ready.map((image) => (
                  <li key={image.artifactId} className="min-w-0">
                    <Thumbnail image={image} href={imagesHref} urls={urls} />
                  </li>
                ))}
              </ul>
            )}
            {urls.error && (
              <p className="mt-3 text-meta text-danger-700">
                {urls.error}{" "}
                <button type="button" onClick={urls.retry} className={`font-medium underline ${focusRing}`}>
                  Retry
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function Thumbnail({
  image,
  href,
  urls,
}: {
  image: ImageArtifact;
  href: string;
  urls: ReturnType<typeof useImageUrls>;
}) {
  const title = imageTitle(image);
  const state = urls.get(image.artifactId);
  const broken = urls.isBroken(image.artifactId);
  return (
    <Link
      href={href}
      scroll={false}
      title={title}
      className={`block aspect-square overflow-hidden rounded-lg border border-line bg-surface-muted ${focusRing}`}
    >
      {state?.status === "ready" && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs, not optimisable
        <img
          src={state.url}
          alt={title}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => urls.reportError(image.artifactId)}
        />
      ) : state?.status === "unavailable" || broken ? (
        <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-slate-400">
          <ImageOff className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only">{title}: preview unavailable</span>
        </span>
      ) : (
        <>
          <Skeleton className="h-full w-full rounded-none" />
          <span className="sr-only">{title}: loading preview</span>
        </>
      )}
    </Link>
  );
}
