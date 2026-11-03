"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listDeviceArtifacts, type ArtifactPage } from "@/lib/artifacts";
import { imageErrorMessage, listDeviceImages, type ImageArtifact } from "@/lib/images";
import { getNotebook, type Notebook } from "@/lib/reNotebook";
import { ApiError } from "@/lib/api";
import { useLatestRequest } from "@/app/components/ui";

/** One card's data: null until its first load. A reload keeps the last data while it runs. */
export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Set when the request was refused (403/404): the user can't see this. */
  forbidden: boolean;
  reload: () => void;
}

/** The first page sizes the Overview asks for (the APIs' largest pages). */
export const OVERVIEW_ARTIFACT_PAGE = 100;
export const OVERVIEW_IMAGE_PAGE = 100;

function useLoadable<T>(load: () => Promise<T>, active: boolean, errorMessage: (err: unknown) => string): Loadable<T> {
  const latest = useLatestRequest();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(() => {
    const token = latest.begin();
    setLoading(true);
    setError(null);
    loadRef.current().then(
      (result) => {
        if (!latest.isCurrent(token)) return;
        setData(result);
        setForbidden(false);
        setLoading(false);
      },
      (err) => {
        if (!latest.isCurrent(token)) return;
        const refused = err instanceof ApiError && (err.status === 403 || err.status === 404);
        setForbidden(refused);
        if (refused) setData(null);
        setError(errorMessage(err));
        setLoading(false);
      }
    );
  }, [latest, errorMessage]);

  // Each time the Overview is opened: the first load, then a refresh (the
  // other sections may have changed things), never while it's closed.
  useEffect(() => {
    if (active) run();
  }, [active, run]);

  return { data, loading, error, forbidden, reload: run };
}

const message = (fallback: string) => (err: unknown) => (err instanceof Error && err.message ? err.message : fallback);
const artifactsError = message("Couldn't load the device's files");
const imagesError = (err: unknown) => imageErrorMessage(err, "Couldn't load images");
const notebookError = message("Couldn't load the RE Notebook");

export interface OverviewData {
  /** The first page of every file linked to the device (all types together). */
  artifacts: Loadable<ArtifactPage>;
  /** The first page of the device's images, newest first. */
  images: Loadable<{ images: ImageArtifact[]; nextToken?: string }>;
  /** The notebook's structure: sections and entries, without their documents. */
  notebook: Loadable<Notebook>;
}

/**
 * The Overview's own data, beyond the device, firmware and CVEs the page
 * already has: three existing read endpoints, requested only while the
 * Overview is open. Held by the page, so going back to the Overview shows
 * the last figures at once while they refresh.
 */
export function useOverviewData(deviceId: string, active: boolean): OverviewData {
  const loadArtifacts = useCallback(
    () => listDeviceArtifacts(deviceId, { limit: OVERVIEW_ARTIFACT_PAGE }),
    [deviceId]
  );
  const loadImages = useCallback(() => listDeviceImages(deviceId, { limit: OVERVIEW_IMAGE_PAGE }), [deviceId]);
  const loadNotebook = useCallback(() => getNotebook(deviceId), [deviceId]);
  return {
    artifacts: useLoadable(loadArtifacts, active, artifactsError),
    images: useLoadable(loadImages, active, imagesError),
    notebook: useLoadable(loadNotebook, active, notebookError),
  };
}
