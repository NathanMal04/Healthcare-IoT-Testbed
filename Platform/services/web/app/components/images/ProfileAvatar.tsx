"use client";

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import type { ImageUrls } from "./useImageData";

const ICON_FALLBACK = "bg-brand-50 text-brand-600";

const SIZES = {
  sm: { box: "h-8 w-8 rounded-lg", icon: "h-4 w-4", fallback: ICON_FALLBACK },
  md: { box: "h-10 w-10 rounded-lg", icon: "h-5 w-5", fallback: ICON_FALLBACK },
  lg: { box: "h-16 w-16 sm:h-20 sm:w-20 rounded-xl", icon: "h-7 w-7 sm:h-8 sm:w-8", fallback: ICON_FALLBACK },
  /** Fills its container (e.g. a device card's image area), cropped to cover it. */
  fill: { box: "h-full w-full", icon: "h-10 w-10", fallback: "bg-gradient-to-br from-surface-muted to-brand-50 text-brand-500/60" },
} as const;

/**
 * A device's profile picture, or the default device icon when it has none or
 * the image can't be shown (no longer viewable, broken, or still loading).
 *
 * The URL comes from the caller's ImageUrls (one cache per list or page, so a
 * page of devices asks for every picture in one request). Callers key this on
 * the image's file, so a replaced file shows at once instead of the old one.
 */
export default function ProfileAvatar({
  artifactId,
  urls,
  alt,
  size = "sm",
  className = "",
}: {
  artifactId?: string;
  urls: ImageUrls;
  alt: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [shownSrc, setShownSrc] = useState<string | null>(null);
  const state = artifactId ? urls.get(artifactId) : undefined;
  const stale = state?.status === "ready" && state.stale;
  const needsUrl = !!artifactId && !shownSrc && (state === undefined || stale);
  const { ensure } = urls;

  useEffect(() => {
    if (needsUrl && artifactId) ensure([artifactId]);
  }, [needsUrl, ensure, artifactId]);

  const sizing = SIZES[size];
  const unavailable = !artifactId || state?.status === "unavailable" || urls.isBroken(artifactId);
  const src = unavailable ? null : shownSrc ?? (state?.status === "ready" && !state.stale ? state.url : null);

  if (!src) {
    return (
      <span
        className={`${sizing.box} shrink-0 ${sizing.fallback} flex items-center justify-center ${className}`}
        role="img"
        aria-label={artifactId && !unavailable ? `Loading ${alt}` : `${alt} (no picture)`}
      >
        <Cpu className={sizing.icon} aria-hidden="true" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs; next/image can't optimise a static export
    <img
      src={src}
      alt={alt}
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onLoad={() => setShownSrc(src)}
      onError={() => {
        setShownSrc(null);
        if (artifactId) urls.reportError(artifactId);
      }}
      className={`${sizing.box} shrink-0 object-cover bg-surface-sunken ${className}`}
    />
  );
}
