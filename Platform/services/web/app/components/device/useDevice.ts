"use client";

import { useCallback, useState } from "react";
import { getDevice, type Device } from "@/lib/devices";
import { deviceInScope, isDeviceUnavailable } from "@/lib/deviceView";

export interface DeviceState {
  device: Device | null;
  /** The device doesn't exist here: another scope's, or one the caller can't use. */
  notFound: boolean;
  loadError: string | null;
  /** Replaces the device (e.g. with an edit's result). */
  setDevice: (device: Device) => void;
  /** Applies a change to the latest device state, not to a render's copy. */
  updateDevice: (update: (current: Device) => Device) => void;
  /** Loads the device; returns the cleanup that ignores a load still running. */
  load: () => () => void;
}

/**
 * One device, shown only in the current scope: a device of another scope (or
 * one the caller can't use) is treated as not found. The caller runs `load`
 * from an effect, alongside the page's other first loads.
 */
export function useDevice(deviceId: string, workspaceId: string | undefined): DeviceState {
  const [device, setDeviceState] = useState<Device | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    getDevice(deviceId).then(
      (found) => {
        if (!active) return;
        const inScope = deviceInScope(found, workspaceId);
        setDeviceState(inScope);
        setNotFound(!inScope);
      },
      (err) => {
        if (!active) return;
        if (isDeviceUnavailable(err)) setNotFound(true);
        else setLoadError(err instanceof Error ? err.message : "Failed to load the device");
      }
    );
    return () => {
      active = false;
    };
  }, [deviceId, workspaceId]);

  const setDevice = useCallback((next: Device) => setDeviceState(next), []);
  const updateDevice = useCallback(
    (update: (current: Device) => Device) => setDeviceState((current) => (current ? update(current) : current)),
    []
  );

  return { device, notFound, loadError, setDevice, updateDevice, load };
}
