"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { getDevices, type Device } from "@/lib/devices";

export default function DashboardPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [devices, setDevices] = useState<Device[] | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);

  useEffect(() => {
    if (loading || !user) return;

    let cancelled = false;

    async function loadDevices() {
      setDevicesLoading(true);
      setDevicesError(null);
      try {
        const result = await getDevices();
        if (!cancelled) setDevices(result);
      } catch (err) {
        if (!cancelled) {
          setDevicesError(
            err instanceof Error ? err.message : "Failed to load devices"
          );
        }
      } finally {
        if (!cancelled) setDevicesLoading(false);
      }
    }

    loadDevices();

    return () => {
      cancelled = true;
    };
  }, [user, loading]);

  if (loading || !user) return null;

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Dashboard</h1>
          <p className="text-slate-400 mt-1 text-sm">
            Device vulnerability analysis overview
          </p>
        </div>
        <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm">
          + Upload Device
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 hover:shadow-md transition-shadow">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Total Devices</p>
          <p className="text-4xl font-bold text-slate-800 mt-2">
            {devicesLoading ? "…" : devices?.length ?? 0}
          </p>
        </div>
      </div>

      {/* Device table */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-semibold text-slate-700">Devices</h2>
          <span className="text-xs text-slate-400">
            {devicesLoading ? "…" : `${devices?.length ?? 0} total`}
          </span>
        </div>

        {devicesLoading ? (
          <div className="px-6 py-8 text-sm text-slate-400">Loading devices…</div>
        ) : devicesError ? (
          <div className="px-6 py-8 text-sm text-red-600">
            Couldn&apos;t load devices: {devicesError}
          </div>
        ) : devices && devices.length === 0 ? (
          <div className="px-6 py-8 text-sm text-slate-400">No devices yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 bg-slate-50/60 border-b border-slate-100">
                <th className="px-6 py-3 font-medium text-xs uppercase tracking-wide">Device</th>
                <th className="px-6 py-3 font-medium text-xs uppercase tracking-wide">Role</th>
              </tr>
            </thead>
            <tbody>
              {devices?.map((device) => (
                <tr
                  key={device.deviceId}
                  className="border-b border-slate-50 hover:bg-slate-50/80 transition-colors"
                >
                  <td className="px-6 py-4 font-medium text-slate-800">
                    {device.name}
                  </td>
                  <td className="px-6 py-4 text-slate-400">{device.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
