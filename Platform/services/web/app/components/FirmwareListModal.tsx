"use client";

import { useEffect, useState } from "react";
import {
  getFirmware,
  sha256Hex,
  presignFirmware,
  uploadFirmwareToS3,
  completeFirmware,
  type Firmware,
  type CompleteFirmwareResponse,
} from "@/lib/firmware";
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

type RetryStage = "checking" | "hashing" | "reserving" | "uploading" | "verifying" | "complete";

const RETRY_STAGE_LABELS: Record<RetryStage, string> = {
  checking: "Checking file...",
  hashing: "Hashing...",
  reserving: "Reserving retry...",
  uploading: "Uploading...",
  verifying: "Verifying...",
  complete: "Complete",
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

  const [retryFirmware, setRetryFirmware] = useState<Firmware | null>(null);
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const [retryFileInputKey, setRetryFileInputKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryStage, setRetryStage] = useState<RetryStage | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryResult, setRetryResult] = useState<CompleteFirmwareResponse | null>(null);

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

  function handleModalClose() {
    if (retrying) return;
    onClose();
  }

  function openRetry(firmware: Firmware) {
    if (retrying) return;
    setRetryFirmware(firmware);
    setRetryFile(null);
    setRetryFileInputKey((k) => k + 1);
    setRetryStage(null);
    setRetryError(null);
    setRetryResult(null);
  }

  function closeRetry() {
    if (retrying) return;
    setRetryFirmware(null);
    setRetryFile(null);
    setRetryFileInputKey((k) => k + 1);
    setRetryStage(null);
    setRetryError(null);
    setRetryResult(null);
  }

  async function handleRetrySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!retryFirmware || retrying) return;

    if (!retryFile) {
      setRetryError("Select the firmware file");
      return;
    }

    setRetrying(true);
    setRetryError(null);
    setRetryResult(null);

    try {
      // Fail-fast local verification only — the backend's immutable
      // metadata and /complete verification remain authoritative. Neither
      // check here calls presignFirmware if it fails.
      setRetryStage("checking");
      if (retryFile.size !== retryFirmware.sizeBytes) {
        throw new Error("Selected file does not match the original firmware (size mismatch)");
      }

      setRetryStage("hashing");
      const hash = await sha256Hex(retryFile);
      if (hash !== retryFirmware.sha256) {
        throw new Error("Selected file does not match the original firmware (checksum mismatch)");
      }

      // retryOfAttemptId is the attempt this component observed from the
      // last getFirmware() call. If another session already superseded it,
      // the backend's conditional write rejects this outright — that
      // rejection is surfaced as-is below, never worked around or retried
      // automatically.
      setRetryStage("reserving");
      const presign = await presignFirmware(device.deviceId, {
        version: retryFirmware.version,
        retryOfAttemptId: retryFirmware.attemptId,
      });

      setRetryStage("uploading");
      await uploadFirmwareToS3(presign.upload, retryFile);

      // The NEW attemptId from the retry presign — not retryFirmware's
      // original one — is what /complete must reference.
      setRetryStage("verifying");
      const completed = await completeFirmware(
        device.deviceId,
        retryFirmware.version,
        presign.attemptId
      );

      // completeFirmware()'s response is authoritative for retry success.
      setRetryResult(completed);
      setRetryStage("complete");

      // Best-effort list refresh only. If this fails, the retry above has
      // already succeeded and stays reported as such — a later reopen or
      // refetch will reconcile the list.
      getFirmware(device.deviceId)
        .then((result) => setFirmwareList(result))
        .catch(() => {
          // Intentionally ignored — see comment above.
        });
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(false);
      setRetryStage((stage) => (stage === "complete" ? stage : null));
    }
  }

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleModalClose();
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
            onClick={handleModalClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-600 text-sm leading-none"
          >
            ✕
          </button>
        </div>

        {retryFirmware ? (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-700">
                Retry {retryFirmware.version}
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Select the exact same firmware file to retry this upload.
              </p>
            </div>

            {retryStage === "complete" && retryResult ? (
              <div className="space-y-4">
                <p className="text-xs text-emerald-700 bg-emerald-50 px-3 py-2 rounded-lg">
                  Firmware {retryResult.version} is {retryResult.status}.
                </p>
                <button
                  type="button"
                  onClick={closeRetry}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg text-sm font-medium transition-colors"
                >
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleRetrySubmit} className="space-y-4">
                <div>
                  <input
                    key={retryFileInputKey}
                    type="file"
                    onChange={(e) => setRetryFile(e.target.files?.[0] ?? null)}
                    disabled={retrying}
                    className="w-full text-sm text-slate-600 disabled:opacity-50"
                  />
                </div>

                {retryStage && (
                  <p className="text-xs text-blue-600 bg-blue-50 px-3 py-2 rounded-lg">
                    {RETRY_STAGE_LABELS[retryStage]}
                  </p>
                )}

                {retryError && (
                  <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{retryError}</p>
                )}

                <div className="flex items-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={closeRetry}
                    disabled={retrying}
                    className="flex-1 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-600 border border-slate-200 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={retrying || !retryFile}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    {retrying ? RETRY_STAGE_LABELS[retryStage ?? "checking"] : "Retry Upload"}
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : firmwareLoading ? (
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
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide"></th>
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
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {firmware.status === "pending" && (
                        <button
                          type="button"
                          onClick={() => openRetry(firmware)}
                          className="text-blue-600 hover:text-blue-700 text-xs font-medium transition-colors"
                        >
                          Retry
                        </button>
                      )}
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
