"use client";

import { useCallback, useRef, useState } from "react";
import { applyDeviceUpdate, setDeviceProfileImage, type Device } from "@/lib/devices";
import { profilePictureErrorMessage } from "@/lib/images";
import { useScopeLock } from "@/context/WorkspaceContext";

export interface ProfileImageControls {
  saving: boolean;
  error: string | null;
  notice: string | null;
  /**
   * Chooses one of the device's images as its profile picture (or removes it
   * with null). Resolves true once saved; on failure the error is set and the
   * device keeps its picture. No image is changed or deleted either way.
   */
  setProfile: (artifactId: string | null, successNotice: string) => Promise<boolean>;
  announce: (notice: string) => void;
  fail: (error: string) => void;
  dismiss: () => void;
}

/**
 * Changes a device's profile picture and holds the outcome to show. The
 * device is updated from the PATCH response through `onDeviceChange`, which
 * applies it to the latest device state, so other edits made meanwhile are
 * kept. One change at a time; the scope can't switch while one is saving.
 */
export function useProfileImage(
  deviceId: string | undefined,
  onDeviceChange: (update: (current: Device) => Device) => void
): ProfileImageControls {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const savingRef = useRef(false);
  useScopeLock(saving);

  const setProfile = useCallback(
    async (artifactId: string | null, successNotice: string) => {
      if (!deviceId || savingRef.current) return false;
      savingRef.current = true;
      setSaving(true);
      setError(null);
      setNotice(null);
      try {
        const updated = await setDeviceProfileImage(deviceId, artifactId);
        onDeviceChange((current) => applyDeviceUpdate(current, updated));
        setNotice(successNotice);
        return true;
      } catch (err) {
        setError(profilePictureErrorMessage(err));
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [deviceId, onDeviceChange]
  );

  const announce = useCallback((message: string) => {
    setError(null);
    setNotice(message);
  }, []);
  const fail = useCallback((message: string) => {
    setNotice(null);
    setError(message);
  }, []);
  const dismiss = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return { saving, error, notice, setProfile, announce, fail, dismiss };
}
