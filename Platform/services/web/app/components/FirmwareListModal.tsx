"use client";

import { useEffect, useState } from "react";
import {
  firmwareReverseEngineeringStatus,
  formatBytes,
  listDeviceArtifacts,
  retryArtifactUpload,
  updateFirmwareReverseEngineeringStatus,
  type Artifact,
  type SingleUploadStage,
} from "@/lib/artifacts";
import type { Device } from "@/lib/devices";
import type { ReverseEngineeringStatus } from "@/lib/reverseEngineering";
import ReverseEngineeringStatusSelect from "@/app/components/ReverseEngineeringStatusSelect";

interface FirmwareListModalProps {
  device: Device;
  onClose: () => void;
}

const STATUS_BADGE_STYLES: Record<string, string> = {
  ready: "text-emerald-700 bg-emerald-50",
  pending: "text-amber-700 bg-amber-50",
  verifying: "text-blue-700 bg-blue-50",
  failed: "text-red-700 bg-red-50",
};

type RetryStage = SingleUploadStage | "checking" | "complete";

const RETRY_STAGE_LABELS: Record<RetryStage, string> = {
  checking: "Checking file...",
  hashing: "Hashing...",
  reserving: "Reserving retry...",
  uploading: "Uploading...",
  verifying: "Verifying...",
  complete: "Complete",
};

function stageLabel(stage: RetryStage, progress: number | null): string {
  const label = RETRY_STAGE_LABELS[stage];
  if (progress === null || (stage !== "hashing" && stage !== "uploading")) return label;
  return `${label.replace("...", "")} ${Math.floor(progress * 100)}%`;
}

// Matches VERIFY_STALE_SEC on the backend: a check that hasn't finished in
// 20 minutes has stalled, and the upload can be retried.
const VERIFY_STALE_MS = 20 * 60 * 1000;

function isRetryable(firmware: Artifact): boolean {
  if (firmware.status === "pending" || firmware.status === "failed") return true;
  if (firmware.status !== "verifying" || !firmware.statusUpdatedAt) return false;
  return Date.now() - new Date(firmware.statusUpdatedAt).getTime() > VERIFY_STALE_MS;
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export default function FirmwareListModal({ device, onClose }: FirmwareListModalProps) {
  const [firmwareList, setFirmwareList] = useState<Artifact[] | null>(null);
  const [firmwareLoading, setFirmwareLoading] = useState(true);
  const [firmwareError, setFirmwareError] = useState<string | null>(null);

  const [retryFirmware, setRetryFirmware] = useState<Artifact | null>(null);
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const [retryFileInputKey, setRetryFileInputKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryStage, setRetryStage] = useState<RetryStage | null>(null);
  const [retryProgress, setRetryProgress] = useState<number | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const [savingReIds, setSavingReIds] = useState<Set<string>>(new Set());
  const [reError, setReError] = useState<string | null>(null);

  // Fresh fetch every time the viewed device changes — no caching. This
  // component is the sole owner of this state; a failure here never touches
  // the dashboard's own device list/loading/error state.
  useEffect(() => {
    let cancelled = false;
    setFirmwareLoading(true);
    setFirmwareError(null);
    setFirmwareList(null);

    loadFirmware(device.deviceId)
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

  // The select shows the list's saved value, which only changes once the API
  // has saved the new one. Only reverseEngineeringStatus is taken from the
  // response; the upload status shown alongside it is left as it was.
  async function handleReStatusChange(firmware: Artifact, next: ReverseEngineeringStatus) {
    if (next === firmwareReverseEngineeringStatus(firmware) || savingReIds.has(firmware.artifactId)) return;

    setReError(null);
    setSavingReIds((current) => new Set(current).add(firmware.artifactId));
    try {
      const updated = await updateFirmwareReverseEngineeringStatus(firmware.artifactId, next);
      setFirmwareList((current) =>
        current?.map((f) =>
          f.artifactId === firmware.artifactId
            ? { ...f, reverseEngineeringStatus: updated.reverseEngineeringStatus }
            : f
        ) ?? current
      );
    } catch (err) {
      setReError(
        `Couldn't update ${firmware.version ?? firmware.name}: ${err instanceof Error ? err.message : "Failed to update status"}`
      );
    } finally {
      setSavingReIds((current) => {
        const remaining = new Set(current);
        remaining.delete(firmware.artifactId);
        return remaining;
      });
    }
  }

  function handleModalClose() {
    if (retrying) return;
    onClose();
  }

  function openRetry(firmware: Artifact) {
    if (retrying) return;
    setRetryFirmware(firmware);
    setRetryFile(null);
    setRetryFileInputKey((k) => k + 1);
    setRetryStage(null);
    setRetryProgress(null);
    setRetryError(null);
  }

  function closeRetry() {
    if (retrying) return;
    setRetryFirmware(null);
    setRetryFile(null);
    setRetryFileInputKey((k) => k + 1);
    setRetryStage(null);
    setRetryProgress(null);
    setRetryError(null);
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

    try {
      // Size and SHA-256 are checked locally before the retry is reserved;
      // the backend verifies the upload again when it completes.
      await retryArtifactUpload(retryFirmware, retryFile, (stage, progress) => {
        setRetryStage(stage);
        setRetryProgress(progress ?? null);
      });
      setRetryStage("complete");

      // Best-effort list refresh only. If this fails, the retry above has
      // already succeeded and stays reported as such — a later reopen or
      // refetch will reconcile the list.
      loadFirmware(device.deviceId)
        .then((result) => setFirmwareList(result))
        .catch(() => {
          // Intentionally ignored — see comment above.
        });
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(false);
      setRetryProgress(null);
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
      <div className="w-full max-w-3xl bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
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

            {retryStage === "complete" ? (
              <div className="space-y-4">
                <p className="text-xs text-emerald-700 bg-emerald-50 px-3 py-2 rounded-lg">
                  Firmware {retryFirmware.version} is ready.
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
                    {stageLabel(retryStage, retryProgress)}
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
                    {retrying ? stageLabel(retryStage ?? "checking", retryProgress) : "Retry Upload"}
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
            {reError && (
              <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-3">{reError}</p>
            )}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 bg-slate-50/60 border-b border-slate-100">
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Version</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Upload</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">File</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">RE Status</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Size</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Date</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide"></th>
                </tr>
              </thead>
              <tbody>
                {firmwareList?.map((firmware) => (
                  <tr
                    key={firmware.artifactId}
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
                      {firmware.statusReason && (
                        <p className="text-xs text-red-600 mt-1">{firmware.statusReason}</p>
                      )}
                    </td>
                    <td className="px-3 py-3 text-slate-500 break-all">
                      {firmware.originalFilename}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <ReverseEngineeringStatusSelect
                        value={firmwareReverseEngineeringStatus(firmware)}
                        saving={savingReIds.has(firmware.artifactId)}
                        onChange={(next) => void handleReStatusChange(firmware, next)}
                        ariaLabel={`Reverse-engineering status for firmware ${firmware.version ?? firmware.name}`}
                      />
                    </td>
                    <td className="px-3 py-3 text-slate-500 whitespace-nowrap">
                      {formatBytes(firmware.sizeBytes)}
                    </td>
                    <td className="px-3 py-3 text-slate-500 whitespace-nowrap">
                      {formatDate(firmware.uploadedAt ?? firmware.createdAt)}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {isRetryable(firmware) && (
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

// Firmware is stored as artifacts with type=firmware, linked to the device.
// A device has few firmware versions, so the first page of 100 is all of them
// in practice; later pages are fetched anyway so nothing is ever hidden.
async function loadFirmware(deviceId: string): Promise<Artifact[]> {
  const firmware: Artifact[] = [];
  let nextToken: string | undefined;
  do {
    const page = await listDeviceArtifacts(deviceId, { type: "firmware", limit: 100, nextToken });
    firmware.push(...page.artifacts);
    nextToken = page.nextToken;
  } while (nextToken);
  return firmware;
}
