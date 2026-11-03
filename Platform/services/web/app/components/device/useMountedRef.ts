"use client";

import { useEffect, useRef } from "react";

/** Whether the component is still mounted, for results that arrive after it has gone. */
export function useMountedRef(): React.MutableRefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}
