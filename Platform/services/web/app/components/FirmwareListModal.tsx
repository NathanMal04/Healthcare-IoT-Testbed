"use client";

import { useEffect, useState } from "react";
import { getFirmware, type Firmware } from "@/lib/firmware";
import type { Device } from "@/lib/devices";

interface FirmwareListModalProps {
  device: Device;
  onClose: () => void;
}

const STATUS_BADGE_STYLES: Record<string, string> = {
  ready: "text-emerald-700 bg-emerald-50",
  pending: "text-amber-700 bg-amber-50",
  failed: "text-red-700 bg-red-50",
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return unitIndex === 0
    ? `${value} ${units[unitIndex]}`
    : `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export default function FirmwareListModal({ device, onClose }: FirmwareListModalProps) {
  const [firmwareList, setFirmwareList] = useState<Firmware[] | null>(null);
  const [firmwareLoading, setFirmwareLoading] = useState(true);
  const [firmwareError, setFirmwareError] = useState<string | null>(null);

  // Fresh fetch every time the viewed device changes — no caching. This
  // component is the sole owner of this state; a failure here never touches
  // the dashboard's own device list/loading/error state.
  useEffect(() => {
    let cancelled = false;
    setFirmwareLoading(true);
    setFirmwareError(null);
    setFirmwareList(null);

    getFirmware(device.deviceId)
      .then((result) => {
        if (!cancelled) setFirmwareList(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setFirmwareError(err instanceof Error ? err.message : "Failed to load firmware");
        }
      })
      .finally(() => {
        if (!cancelled) setFirmwareLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [device.deviceId]);

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-800 tracking-tight">Firmware</h2>
            <p className="text-slate-400 text-sm mt-1">{device.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-600 text-sm leading-none"
          >
            ✕
          </button>
        </div>

        {firmwareLoading ? (
          <p className="text-sm text-slate-400 py-8 text-center">Loading firmware…</p>
        ) : firmwareError ? (
          <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">
            Couldn&apos;t load firmware: {firmwareError}
          </p>
        ) : firmwareList && firmwareList.length === 0 ? (
          <p className="text-sm text-slate-400 py-8 text-center">No firmware uploaded yet.</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 bg-slate-50/60 border-b border-slate-100">
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Version</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Status</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">File</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Size</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Date</th>
                </tr>
              </thead>
              <tbody>
                {firmwareList?.map((firmware) => (
                  <tr
                    key={firmware.firmwareId}
                    className="border-b border-slate-50 hover:bg-slate-50/80 transition-colors"
                  >
                    <td className="px-3 py-3 font-medium text-slate-800 whitespace-nowrap">
                      {firmware.version}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                          STATUS_BADGE_STYLES[firmware.status] ?? "text-slate-600 bg-slate-100"
                        }`}
                      >
                        {firmware.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-slate-500 break-all">
                      {firmware.originalFilename}
                    </td>
                    <td className="px-3 py-3 text-slate-500 whitespace-nowrap">
                      {formatBytes(firmware.sizeBytes)}
                    </td>
                    <td className="px-3 py-3 text-slate-500 whitespace-nowrap">
                      {formatDate(firmware.uploadedAt ?? firmware.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
