"use client";

import { useCallback, useEffect, useState } from "react";
import type { Device } from "@/lib/devices";
import type { Artifact } from "@/lib/artifacts";
import { loadDeviceFirmware } from "@/app/components/firmware/FirmwareList";
import { useMountedRef } from "./useMountedRef";

export interface DeviceFirmware {
  /** null until loaded. */
  firmware: Artifact[] | null;
  setFirmware: React.Dispatch<React.SetStateAction<Artifact[] | null>>;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * The device's firmware, requested only once the device is known to be in
 * this scope (`device` set), and again whenever the device record changes.
 */
export function useDeviceFirmware(deviceId: string, device: Device | null): DeviceFirmware {
  const [firmware, setFirmware] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useMountedRef();

  const reload = useCallback(async () => {
    try {
      const result = await loadDeviceFirmware(deviceId);
      if (isMountedRef.current) {
        setFirmware(result);
        setError(null);
      }
    } catch (err) {
      if (isMountedRef.current) setError(err instanceof Error ? err.message : "Failed to load firmware");
    }
  }, [deviceId, isMountedRef]);

  useEffect(() => {
    if (device) void reload();
  }, [device, reload]);

  return { firmware, setFirmware, error, reload };
}
