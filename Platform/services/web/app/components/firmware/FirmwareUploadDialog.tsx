"use client";

import { useRef, useState } from "react";
import { FileUp, UploadCloud } from "lucide-react";
import { MAX_ARTIFACT_SIZE_BYTES, formatBytes, uploadArtifact, type SingleUploadStage } from "@/lib/artifacts";
import type { Device } from "@/lib/devices";
import { useScopeLock } from "@/context/WorkspaceContext";
import { Alert, Button, Dialog, inputClass, labelClass } from "@/app/components/ui";

type UploadStage = SingleUploadStage | "complete";

const UPLOAD_STAGE_LABELS: Record<UploadStage, string> = {
  hashing: "Hashing...",
  reserving: "Reserving upload...",
  uploading: "Uploading...",
  verifying: "Verifying...",
  complete: "Complete",
};

function uploadStageLabel(stage: UploadStage, progress: number | null): string {
  const label = UPLOAD_STAGE_LABELS[stage];
  if (progress === null || (stage !== "hashing" && stage !== "uploading")) return label;
  return `${label.replace("...", "")} ${Math.floor(progress * 100)}%`;
}

/**
 * Uploads one firmware version for one existing device: an artifact with
 * type=firmware linked to the device. The backend keeps versions unique per
 * device. With `device` the device is fixed; otherwise it must be chosen
 * from `devices` (the current scope's).
 */
export default function FirmwareUploadDialog({
  device,
  devices,
  onClose,
  onUploaded,
}: {
  device?: Device;
  devices?: Device[];
  onClose: () => void;
  onUploaded?: (version: string) => void;
}) {
  const [deviceId, setDeviceId] = useState(device?.deviceId ?? "");
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState<UploadStage | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedVersion, setUploadedVersion] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // An upload belongs to the current scope; don't let the scope change under it.
  useScopeLock(uploading);

  const target = device ?? devices?.find((d) => d.deviceId === deviceId) ?? null;
  const isUploadFormValid = version.trim() !== "" && file !== null && target !== null;

  function close() {
    if (uploading) return;
    onClose();
  }

  function chooseFile(next: File | null) {
    if (uploading) return;
    setFile(next);
    setUploadError(null);
  }

  async function handleUploadSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (uploading) return;

    if (!target) {
      setUploadError("Choose the device this firmware belongs to");
      return;
    }
    const trimmedVersion = version.trim();
    if (!trimmedVersion) {
      setUploadError("Version is required");
      return;
    }
    if (!file) {
      setUploadError("Select a firmware file");
      return;
    }
    if (file.size <= 0) {
      setUploadError("File is empty");
      return;
    }
    if (file.size > MAX_ARTIFACT_SIZE_BYTES) {
      setUploadError("File exceeds the 5 GiB limit");
      return;
    }

    setUploading(true);
    setUploadError(null);
    setUploadedVersion(null);

    try {
      // Firmware is uploaded as an artifact with type=firmware, linked to
      // this device. The backend keeps versions unique per device.
      await uploadArtifact(
        file,
        { type: "firmware", version: trimmedVersion, deviceIds: [target.deviceId] },
        (stage, progress) => {
          setUploadStage(stage);
          setUploadProgress(progress ?? null);
        }
      );

      setUploadedVersion(trimmedVersion);
      setUploadStage("complete");
      setUploadProgress(null);
      setVersion("");
      setFile(null);
      onUploaded?.(trimmedVersion);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
      setUploadStage(null);
      setUploadProgress(null);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog title="Upload firmware" subtitle={device ? device.name : "Add a firmware version to one of your devices"} onClose={close} wide>
      {uploadStage === "complete" && uploadedVersion ? (
        <div className="space-y-4">
          <Alert tone="success">
            Firmware {uploadedVersion} for {target?.name ?? "the device"} is ready.
          </Alert>
          <Button className="w-full" onClick={close}>
            Done
          </Button>
        </div>
      ) : (
        <form onSubmit={handleUploadSubmit} className="space-y-4">
          {!device && (
            <div>
              <label className={labelClass} htmlFor="firmware-device">
                Device
              </label>
              {devices && devices.length > 0 ? (
                <select
                  id="firmware-device"
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  disabled={uploading}
                  className={inputClass}
                >
                  <option value="">Choose a device…</option>
                  {[...devices]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.name}
                      </option>
                    ))}
                </select>
              ) : (
                <p className="text-sm text-slate-500">Add a device first: firmware always belongs to a device.</p>
              )}
            </div>
          )}

          <div>
            <label className={labelClass} htmlFor="firmware-version">
              Version
            </label>
            <input
              id="firmware-version"
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={uploading}
              className={inputClass}
              placeholder="v1.0.0"
            />
          </div>

          <div>
            <span className={labelClass}>Firmware file</span>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!uploading) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) chooseFile(dropped);
              }}
              className={`border-2 border-dashed rounded-xl px-4 py-6 text-center transition-colors ${
                dragging ? "border-brand-500 bg-brand-50" : "border-line-strong bg-surface-muted"
              } ${uploading ? "opacity-60" : ""}`}
            >
              {file ? (
                <div className="flex items-center justify-center gap-2 text-sm text-slate-700">
                  <FileUp className="h-4 w-4 text-brand-600 shrink-0" aria-hidden="true" />
                  <span className="font-medium break-all">{file.name}</span>
                  <span className="text-slate-500 whitespace-nowrap">({formatBytes(file.size)})</span>
                </div>
              ) : (
                <>
                  <UploadCloud className="mx-auto h-7 w-7 text-slate-400" aria-hidden="true" />
                  <p className="text-sm text-slate-600 mt-1.5">Drag and drop the firmware file here</p>
                </>
              )}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="mt-2 text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
              >
                {file ? "Choose a different file" : "or browse"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  chooseFile(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
            </div>
            <p className="text-xs text-slate-500 mt-1">Maximum size: 5 GiB</p>
          </div>

          {uploadStage && <Alert tone="info">{uploadStageLabel(uploadStage, uploadProgress)}</Alert>}
          {uploadError && <Alert tone="error">{uploadError}</Alert>}

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={close} disabled={uploading}>
              Cancel
            </Button>
            <Button type="submit" disabled={uploading || !isUploadFormValid}>
              {uploading ? uploadStageLabel(uploadStage ?? "hashing", uploadProgress) : "Upload"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
