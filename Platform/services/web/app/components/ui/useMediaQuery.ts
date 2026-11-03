"use client";

import { useEffect, useState } from "react";

function matches(query: string, fallback: boolean): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return fallback;
  return window.matchMedia(query).matches;
}

/**
 * Whether a media query matches, following changes. Where media queries
 * aren't available (tests, prerendering) it reports `fallback`.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  const [value, setValue] = useState(() => matches(query, fallback));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setValue(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, [query]);
  return value;
}

/** The app's large breakpoint (Tailwind lg): side-by-side layouts start here. */
export const LARGE_SCREEN = "(min-width: 1024px)";

/** The app's wide breakpoint (Tailwind xl): a page's own side navigation starts here. */
export const WIDE_SCREEN = "(min-width: 1280px)";
