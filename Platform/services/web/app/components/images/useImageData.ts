"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ImageUrlCache,
  appendImages,
  imageErrorMessage,
  listDeviceImages,
  replaceImage,
  type ImageArtifact,
  type ImageUrlState,
} from "@/lib/images";

// Data hooks shared by the device gallery and, later, a notebook image
// picker: a device's images page by page, and their short-lived view URLs.

export interface DeviceImages {
  images: ImageArtifact[] | null;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /**
   * Loads the next page; resolves true if it added at least one image. A
   * no-op (false) when there is no next page or a load is already running,
   * so it never overtakes a reload (e.g. the one after an upload).
   */
  loadMore: () => Promise<boolean>;
  /** Reloads the first page; overtakes a running "load more". */
  reload: () => Promise<void>;
  replace: (image: ImageArtifact) => void;
}

/** A device's images (GET /devices/{id}/artifacts?type=image), newest upload first. */
export function useDeviceImages(deviceId: string): DeviceImages {
  const [images, setImages] = useState<ImageArtifact[] | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the latest load may update the list.
  const loadIdRef = useRef(0);
  const loadingRef = useRef<"reload" | "more" | null>(null);
  const stateRef = useRef<{ images: ImageArtifact[] | null; nextToken?: string }>({ images: null });
  stateRef.current = { images, nextToken };

  const load = useCallback(
    async (append: boolean): Promise<boolean> => {
      const token = append ? stateRef.current.nextToken : undefined;
      // Checked before taking a load id, so a no-op never cancels another load.
      if (append && (!token || loadingRef.current)) return false;
      const loadId = ++loadIdRef.current;
      loadingRef.current = append ? "more" : "reload";
      setLoading(true);
      setError(null);
      try {
        const page = await listDeviceImages(deviceId, { nextToken: token });
        if (loadId !== loadIdRef.current) return false;
        const before = append ? stateRef.current.images ?? [] : [];
        const merged = append ? appendImages(before, page.images) : page.images;
        // Kept current right away, so a load started before the re-render sees it.
        stateRef.current = { images: merged, nextToken: page.nextToken };
        setImages(merged);
        setNextToken(page.nextToken);
        return merged.length > before.length;
      } catch (err) {
        if (loadId === loadIdRef.current) setError(imageErrorMessage(err, "Couldn't load images"));
        return false;
      } finally {
        if (loadId === loadIdRef.current) {
          loadingRef.current = null;
          setLoading(false);
        }
      }
    },
    [deviceId]
  );

  useEffect(() => {
    void load(false);
    const loadIds = loadIdRef;
    const loadingState = loadingRef;
    return () => {
      loadIds.current++;
      loadingState.current = null;
    };
  }, [load]);

  const loadMore = useCallback(() => load(true), [load]);
  const reload = useCallback(async () => {
    await load(false);
  }, [load]);
  const replace = useCallback((image: ImageArtifact) => {
    setImages((current) => {
      const next = current ? replaceImage(current, image) : current;
      stateRef.current = { ...stateRef.current, images: next };
      return next;
    });
  }, []);

  return { images, hasMore: !!nextToken, loading, error, loadMore, reload, replace };
}

/** A URL younger than this that fails to load is treated as a broken image, not an expired URL. */
const FRESH_URL_MS = 15_000;

export interface ImageUrls {
  get: (artifactId: string) => ImageUrlState | undefined;
  /** Fetches (or refreshes stale) URLs; calls in the same tick share one request. */
  ensure: (artifactIds: string[]) => void;
  /** An <img> failed: an old URL has probably expired, so fetch one new URL; a fresh one means the image is broken. */
  reportError: (artifactId: string) => void;
  isBroken: (artifactId: string) => boolean;
  /** Images that couldn't be shown: unavailable per the server, or broken. */
  problemCount: number;
  /** Set when a whole view-URL request failed (e.g. an expired session). */
  error: string | null;
  /** Asks again for every image: failed requests, unavailable and broken ones included. */
  retry: () => void;
}

/**
 * View URLs for the given images, from one in-memory cache per mounted
 * gallery: never written to storage or sent anywhere but the <img> tags.
 * The cache batches every request made in the same tick, so the gallery's
 * own request and each card's request for its image become one POST.
 */
export function useImageUrls(artifactIds: string[]): ImageUrls {
  const cacheRef = useRef<ImageUrlCache | null>(null);
  if (!cacheRef.current) cacheRef.current = new ImageUrlCache();
  const cache = cacheRef.current;

  const [, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  const retriedRef = useRef(new Set<string>());

  useEffect(() => cache.subscribe(() => setVersion((v) => v + 1)), [cache]);

  const ensure = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      cache.ensure(ids).then(
        () => setError(null),
        (err) => setError(imageErrorMessage(err, "Couldn't load image previews"))
      );
    },
    [cache]
  );

  const key = artifactIds.join(",");
  useEffect(() => {
    ensure(key ? key.split(",") : []);
  }, [key, ensure]);

  const reportError = useCallback(
    (artifactId: string) => {
      const age = cache.ageOf(artifactId);
      if (retriedRef.current.has(artifactId) && age !== undefined && age < FRESH_URL_MS) {
        setBroken((current) => new Set(current).add(artifactId));
        return;
      }
      retriedRef.current.add(artifactId);
      cache.invalidate(artifactId);
      ensure([artifactId]);
    },
    [cache, ensure]
  );

  const retry = useCallback(() => {
    retriedRef.current.clear();
    // Broken images get a fresh URL too, not the one that just failed.
    broken.forEach((id) => cache.invalidate(id));
    setBroken(new Set());
    cache.forgetUnavailable();
    ensure(key ? key.split(",") : []);
  }, [cache, broken, ensure, key]);

  return {
    get: (artifactId) => cache.get(artifactId),
    ensure,
    reportError,
    isBroken: (artifactId) => broken.has(artifactId),
    problemCount: cache.unavailableCount() + broken.size,
    error,
    retry,
  };
}
