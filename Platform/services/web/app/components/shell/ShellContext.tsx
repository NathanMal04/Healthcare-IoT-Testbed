"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Crumb } from "./navigation";

interface ShellContextValue {
  /** A page's own breadcrumb trail, replacing the one derived from its route. */
  pageCrumbs: Crumb[] | null;
  setPageCrumbs: (crumbs: Crumb[] | null) => void;
}

const ShellContext = createContext<ShellContextValue>({ pageCrumbs: null, setPageCrumbs: () => undefined });

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [pageCrumbs, setPageCrumbs] = useState<Crumb[] | null>(null);
  const value = useMemo(() => ({ pageCrumbs, setPageCrumbs }), [pageCrumbs]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellContextValue {
  return useContext(ShellContext);
}

/**
 * Lets a page name its record in the top bar's breadcrumb (e.g. "Devices /
 * Acme Cam 1000" instead of "Devices / Device"). Pass null until the record
 * is known. The page's trail is dropped when it unmounts. Outside the
 * application shell this does nothing.
 */
export function usePageCrumbs(crumbs: Crumb[] | null): void {
  const { setPageCrumbs } = useShell();
  // Compared by content, so a new array with the same steps changes nothing.
  const key = crumbs ? JSON.stringify(crumbs) : null;
  useEffect(() => {
    setPageCrumbs(key ? (JSON.parse(key) as Crumb[]) : null);
  }, [key, setPageCrumbs]);
  useEffect(() => () => setPageCrumbs(null), [setPageCrumbs]);
}
