"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { getDevices, type Device } from "@/lib/devices";
import { cveErrorMessage, listCves, type Cve, type CveSummary } from "@/lib/cves";
import { cvesForDevice } from "@/lib/dashboard";
import { isWorkspaceUnavailable } from "@/lib/workspaces";
import { useMountedRef } from "./useMountedRef";

export interface DeviceCves {
  /** Every CVE of the scope; null until the first load. */
  cves: CveSummary[] | null;
  /** The ones linked to this device. */
  deviceCves: CveSummary[];
  error: string | null;
  loading: boolean;
  /** The scope's devices, which name the other devices a CVE is linked to. */
  scopeDevices: Device[] | null;
  scopeDevicesError: string | null;
  load: () => Promise<void>;
  upsert: (cve: Cve) => void;
  remove: (cveRecordId: string) => void;
}

/**
 * The scope's CVEs and devices for one device's page. Only the latest load
 * may update them (e.g. Refresh overtaking the first load). The CVE list is
 * the workspace-scoped request, so its refusal is what reports a workspace
 * that has gone.
 */
export function useDeviceCves(
  deviceId: string,
  workspaceId: string | undefined,
  reportWorkspaceUnavailable: () => void
): DeviceCves {
  const [cves, setCves] = useState<CveSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scopeDevices, setScopeDevices] = useState<Device[] | null>(null);
  const [scopeDevicesError, setScopeDevicesError] = useState<string | null>(null);
  const isMountedRef = useMountedRef();
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    setLoading(true);
    const [cveResult, deviceResult] = await Promise.allSettled([listCves(workspaceId), getDevices(workspaceId)]);
    if (!isMountedRef.current || loadId !== loadIdRef.current) return;
    if (cveResult.status === "fulfilled") {
      setCves(cveResult.value);
      setError(null);
    } else {
      setError(cveErrorMessage(cveResult.reason, "Couldn't load vulnerabilities"));
      if (workspaceId && isWorkspaceUnavailable(cveResult.reason)) reportWorkspaceUnavailable();
    }
    if (deviceResult.status === "fulfilled") {
      setScopeDevices(deviceResult.value);
      setScopeDevicesError(null);
    } else {
      setScopeDevices(null);
      setScopeDevicesError("Device names couldn't be loaded.");
    }
    setLoading(false);
  }, [workspaceId, reportWorkspaceUnavailable, isMountedRef]);

  const deviceCves = useMemo(() => cvesForDevice(cves ?? [], deviceId), [cves, deviceId]);

  const upsert = useCallback((cve: Cve) => {
    setCves((current) => current?.map((c) => (c.cveRecordId === cve.cveRecordId ? cve : c)) ?? current);
  }, []);
  const remove = useCallback((cveRecordId: string) => {
    setCves((current) => current?.filter((c) => c.cveRecordId !== cveRecordId) ?? current);
  }, []);

  return { cves, deviceCves, error, loading, scopeDevices, scopeDevicesError, load, upsert, remove };
}
