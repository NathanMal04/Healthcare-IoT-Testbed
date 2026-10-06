"use client";

// Firmware lists, reverse-engineering status changes and upload retries,
// shared by the device page's Firmware tab and the Firmware page. The logic
// is the former FirmwareListModal's, unchanged; only its presentation moved.

import { useState } from "react";
import { Download, Eye, RotateCcw } from "lucide-react";
import {
  firmwareReverseEngineeringStatus,
  formatBytes,
  getArtifactDownloadUrl,
  listDeviceArtifacts,
  retryArtifactUpload,
  updateFirmwareReverseEngineeringStatus,
  type Artifact,
  type SingleUploadStage,
} from "@/lib/artifacts";
import type { ReverseEngineeringStatus } from "@/lib/reverseEngineering";
import { useScopeLock } from "@/context/WorkspaceContext";
import { deviceHref } from "@/lib/routes";
import ReverseEngineeringStatusSelect from "@/app/components/ReverseEngineeringStatusSelect";
import { Alert, Button, DataTable, Dialog, RowActionsMenu, StatusBadge, formatDate, type Column } from "@/app/components/ui";

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

export function isRetryable(firmware: Artifact): boolean {
  if (firmware.status === "pending" || firmware.status === "failed") return true;
  if (firmware.status !== "verifying" || !firmware.statusUpdatedAt) return false;
  return Date.now() - new Date(firmware.statusUpdatedAt).getTime() > VERIFY_STALE_MS;
}

// Firmware is stored as artifacts with type=firmware, linked to the device.
// A device has few firmware versions, so the first page of 100 is all of them
// in practice; later pages are fetched anyway so nothing is ever hidden.
export async function loadDeviceFirmware(deviceId: string): Promise<Artifact[]> {
  const firmware: Artifact[] = [];
  let nextToken: string | undefined;
  do {
    const page = await listDeviceArtifacts(deviceId, { type: "firmware", limit: 100, nextToken });
    firmware.push(...page.artifacts);
    nextToken = page.nextToken;
  } while (nextToken);
  return firmware;
}

/**
 * Reverse-engineering status changes for a firmware list. The select shows
 * the list's saved value, which only changes once the API has saved the new
 * one. Only reverseEngineeringStatus is taken from the response; the upload
 * status shown alongside it is left as it was.
 */
export function useFirmwareReStatus(setList: (update: (current: Artifact[] | null) => Artifact[] | null) => void) {
  const [savingReIds, setSavingReIds] = useState<Set<string>>(new Set());
  const [reError, setReError] = useState<string | null>(null);

  async function changeReStatus(firmware: Artifact, next: ReverseEngineeringStatus) {
    if (next === firmwareReverseEngineeringStatus(firmware) || savingReIds.has(firmware.artifactId)) return;

    setReError(null);
    setSavingReIds((current) => new Set(current).add(firmware.artifactId));
    try {
      const updated = await updateFirmwareReverseEngineeringStatus(firmware.artifactId, next);
      setList(
        (current) =>
          current?.map((f) =>
            f.artifactId === firmware.artifactId ? { ...f, reverseEngineeringStatus: updated.reverseEngineeringStatus } : f
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

  return { savingReIds, reError, setReError, changeReStatus };
}

/** The firmware table. Device names are shown when `deviceNames` is given (scope-wide list). */
export function FirmwareTable({
  firmware,
  deviceNames,
  savingReIds,
  onReStatusChange,
  onRetry,
}: {
  firmware: Artifact[];
  deviceNames?: ReadonlyMap<string, string>;
  savingReIds: Set<string>;
  onReStatusChange: (firmware: Artifact, next: ReverseEngineeringStatus) => void;
  onRetry: (firmware: Artifact) => void;
}) {
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function download(f: Artifact) {
    setDownloadError(null);
    try {
      window.location.assign(await getArtifactDownloadUrl(f.artifactId));
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Download failed");
    }
  }

  const columns: Column<Artifact>[] = [
    {
      key: "version",
      header: "Version",
      className: "whitespace-nowrap",
      cell: (f) => <span className="font-medium text-slate-900">{f.version ?? "—"}</span>,
    },
    {
      key: "file",
      header: "File",
      cell: (f) => <span className="text-slate-600 break-all">{f.originalFilename}</span>,
    },
    ...(deviceNames
      ? [
          {
            key: "devices",
            header: "Devices",
            cell: (f: Artifact) =>
              f.deviceIds.length ? (
                <div className="flex flex-wrap gap-1 max-w-[14rem]">
                  {f.deviceIds.map((id) => (
                    <span key={id} className="text-xs bg-brand-50 text-brand-700 px-1.5 py-0.5 rounded-md whitespace-nowrap">
                      {deviceNames.get(id) ?? "Unknown device"}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-slate-300">—</span>
              ),
          } satisfies Column<Artifact>,
        ]
      : []),
    {
      key: "size",
      header: "Size",
      hideBelow: "md",
      className: "whitespace-nowrap text-slate-600 tabular-nums",
      cell: (f) => formatBytes(f.sizeBytes),
    },
    {
      key: "uploaded",
      header: "Uploaded",
      hideBelow: "lg",
      className: "whitespace-nowrap text-slate-500",
      cell: (f) => formatDate(f.uploadedAt ?? f.createdAt),
    },
    {
      key: "upload",
      header: "Upload",
      cell: (f) => (
        <div>
          <StatusBadge status={f.status} />
          {f.statusReason && <p className="text-xs text-red-600 mt-1 max-w-[14rem]">{f.statusReason}</p>}
        </div>
      ),
    },
    {
      key: "re",
      header: "RE status",
      className: "whitespace-nowrap",
      cell: (f) => (
        <ReverseEngineeringStatusSelect
          value={firmwareReverseEngineeringStatus(f)}
          saving={savingReIds.has(f.artifactId)}
          onChange={(next) => onReStatusChange(f, next)}
          ariaLabel={`Reverse-engineering status for firmware ${f.version ?? f.name}`}
        />
      ),
    },
    {
      key: "actions",
      header: "Actions",
      headerClassName: "text-right",
      className: "text-right",
      cell: (f) => (
        <RowActionsMenu
          label={`Actions for firmware ${f.version ?? f.name}`}
          actions={[
            // On the scope-wide list, a link to the firmware's device.
            deviceNames &&
              f.deviceIds.length === 1 &&
              deviceNames.has(f.deviceIds[0]) && {
                label: "View device",
                icon: Eye,
                href: deviceHref(f.deviceIds[0], "firmware"),
              },
            f.status === "ready" && { label: "Download", icon: Download, onSelect: () => void download(f) },
            isRetryable(f) && { label: "Retry upload", icon: RotateCcw, onSelect: () => onRetry(f) },
          ]}
        />
      ),
    },
  ];

  return (
    <>
      {downloadError && (
        <Alert tone="error" className="mx-5 mt-3" onDismiss={() => setDownloadError(null)}>
          Couldn&apos;t download: {downloadError}
        </Alert>
      )}
      <DataTable columns={columns} rows={firmware} rowKey={(f) => f.artifactId} minWidth={deviceNames ? "48rem" : "40rem"} />
    </>
  );
}

/**
 * Retries an interrupted firmware upload with the same file. The size and
 * SHA-256 are checked locally before the retry is reserved; the backend
 * verifies the upload again when it completes.
 */
export function FirmwareRetryDialog({
  firmware,
  onClose,
  onRetried,
}: {
  firmware: Artifact;
  onClose: () => void;
  /** Best-effort list refresh after a successful retry. */
  onRetried: () => void;
}) {
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryStage, setRetryStage] = useState<RetryStage | null>(null);
  const [retryProgress, setRetryProgress] = useState<number | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  // The retry belongs to the current scope; keep it from changing mid-upload.
  useScopeLock(retrying);

  function close() {
    if (retrying) return;
    onClose();
  }

  async function handleRetrySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (retrying) return;

    if (!retryFile) {
      setRetryError("Select the firmware file");
      return;
    }

    setRetrying(true);
    setRetryError(null);

    try {
      await retryArtifactUpload(firmware, retryFile, (stage, progress) => {
        setRetryStage(stage);
        setRetryProgress(progress ?? null);
      });
      setRetryStage("complete");
      // Best-effort list refresh only. If it fails, the retry above has
      // already succeeded and stays reported as such.
      onRetried();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(false);
      setRetryProgress(null);
      setRetryStage((stage) => (stage === "complete" ? stage : null));
    }
  }

  return (
    <Dialog
      title={`Retry ${firmware.version ?? firmware.name}`}
      subtitle="Select the exact same firmware file to retry this upload."
      onClose={close}
      wide
    >
      {retryStage === "complete" ? (
        <div className="space-y-4">
          <Alert tone="success">Firmware {firmware.version} is ready.</Alert>
          <Button className="w-full" onClick={close}>
            Done
          </Button>
        </div>
      ) : (
        <form onSubmit={handleRetrySubmit} className="space-y-4">
          <input
            type="file"
            onChange={(e) => setRetryFile(e.target.files?.[0] ?? null)}
            disabled={retrying}
            className="w-full text-sm text-slate-600 file:mr-3 file:h-9 file:px-3 file:rounded-lg file:border file:border-line file:bg-white file:text-sm file:font-medium file:text-slate-700 hover:file:bg-surface-muted disabled:opacity-50"
          />
          {retryStage && <Alert tone="info">{stageLabel(retryStage, retryProgress)}</Alert>}
          {retryError && <Alert tone="error">{retryError}</Alert>}
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={close} disabled={retrying}>
              Cancel
            </Button>
            <Button type="submit" disabled={retrying || !retryFile}>
              {retrying ? stageLabel(retryStage ?? "checking", retryProgress) : "Retry upload"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
