"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

export interface LatestRequest {
  /** Starts a request: returns its token, and makes every earlier token stale. */
  begin: () => number;
  /** Whether a token is still the latest one (and the component still mounted). */
  isCurrent: (token: number) => boolean;
  /** Makes every running request stale (e.g. before an unrelated reset). */
  invalidate: () => void;
}

/**
 * "Only the latest load may update the page." Replaces the hand-written
 * load-id counters: take a token before a request, and apply its result
 * only while the token is current. Unmounting makes every token stale, so
 * a late response never updates an unmounted component.
 *
 *   const latest = useLatestRequest();
 *   const token = latest.begin();
 *   const page = await listThings();
 *   if (!latest.isCurrent(token)) return;
 *   setThings(page);
 */
export function useLatestRequest(): LatestRequest {
  const counter = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      counter.current++;
    };
  }, []);

  const begin = useCallback(() => ++counter.current, []);
  const isCurrent = useCallback((token: number) => mounted.current && token === counter.current, []);
  const invalidate = useCallback(() => {
    counter.current++;
  }, []);

  return useMemo(() => ({ begin, isCurrent, invalidate }), [begin, isCurrent, invalidate]);
}
