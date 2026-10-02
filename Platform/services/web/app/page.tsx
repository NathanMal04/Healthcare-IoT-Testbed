"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  getDevices,
  createDevice,
  updateDeviceReverseEngineeringStatus,
  type Device,
  type ReverseEngineeringStatus,
} from "@/lib/devices";
import {
  MAX_ARTIFACT_SIZE_BYTES,
  uploadArtifact,
  type SingleUploadStage,
} from "@/lib/artifacts";
import FirmwareListModal from "@/app/components/FirmwareListModal";
import ReverseEngineeringStatusSelect from "@/app/components/ReverseEngineeringStatusSelect";

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

export default function DashboardPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [devices, setDevices] = useState<Device[] | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [viewDevice, setViewDevice] = useState<Device | null>(null);

  const [uploadDevice, setUploadDevice] = useState<Device | null>(null);
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState<UploadStage | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedVersion, setUploadedVersion] = useState<string | null>(null);

  const [savingStatusIds, setSavingStatusIds] = useState<Set<string>>(new Set());
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  async function loadDevices() {
    if (!isMountedRef.current) return;
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const result = await getDevices();
      if (isMountedRef.current) setDevices(result);
    } catch (err) {
      if (isMountedRef.current) {
        setDevicesError(
          err instanceof Error ? err.message : "Failed to load devices"
        );
      }
    } finally {
      if (isMountedRef.current) setDevicesLoading(false);
    }
  }

  useEffect(() => {
    if (loading || !user) return;
    loadDevices();
  }, [user, loading]);

  function openAddModal() {
    setIsAddOpen(true);
  }

  function closeAddModal() {
    if (submitting) return;
    setIsAddOpen(false);
    setName("");
    setType("");
    setSubmitError(null);
  }

  const isFormValid = name.trim() !== "" && type.trim() !== "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedType = type.trim();
    if (!trimmedName || !trimmedType || submitting) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      await createDevice({ name: trimmedName, type: trimmedType });
      await loadDevices();
      setIsAddOpen(false);
      setName("");
      setType("");
      setSubmitError(null);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to create device"
      );
    } finally {
      setSubmitting(false);
    }
  }

  // The select is controlled by the device list, which only changes once the
  // API has saved the new value; on failure it keeps showing the saved one.
  async function handleStatusChange(device: Device, next: ReverseEngineeringStatus) {
    if (next === device.reverseEngineeringStatus || savingStatusIds.has(device.deviceId)) return;

    setStatusError(null);
    setSavingStatusIds((current) => new Set(current).add(device.deviceId));
    try {
      const updated = await updateDeviceReverseEngineeringStatus(device.deviceId, next);
      if (!isMountedRef.current) return;
      setDevices((current) =>
        current?.map((d) =>
          d.deviceId === device.deviceId
            ? { ...d, reverseEngineeringStatus: updated.reverseEngineeringStatus }
            : d
        ) ?? current
      );
    } catch (err) {
      if (!isMountedRef.current) return;
      setStatusError(
        `Couldn't update ${device.name}: ${err instanceof Error ? err.message : "Failed to update status"}`
      );
    } finally {
      if (isMountedRef.current) {
        setSavingStatusIds((current) => {
          const remaining = new Set(current);
          remaining.delete(device.deviceId);
          return remaining;
        });
      }
    }
  }

  function openUploadModal(device: Device) {
    if (uploading) return;
    closeViewModal();
    setUploadDevice(device);
    setVersion("");
    setFile(null);
    setFileInputKey((k) => k + 1);
    setUploadStage(null);
    setUploadProgress(null);
    setUploadError(null);
    setUploadedVersion(null);
  }

  function closeUploadModal() {
    if (uploading) return;
    setUploadDevice(null);
    setVersion("");
    setFile(null);
    setFileInputKey((k) => k + 1);
    setUploadStage(null);
    setUploadProgress(null);
    setUploadError(null);
    setUploadedVersion(null);
  }

  function openViewModal(device: Device) {
    if (uploading) return;
    closeUploadModal();
    setViewDevice(device);
  }

  function closeViewModal() {
    setViewDevice(null);
  }

  const isUploadFormValid = version.trim() !== "" && file !== null;

  async function handleUploadSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadDevice || uploading) return;

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
        { type: "firmware", version: trimmedVersion, deviceIds: [uploadDevice.deviceId] },
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
      setFileInputKey((k) => k + 1);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
      setUploadStage(null);
      setUploadProgress(null);
    } finally {
      setUploading(false);
    }
  }

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
        <button
          onClick={openAddModal}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm"
        >
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

        {statusError && (
          <p className="text-xs text-red-600 bg-red-50 px-6 py-2">{statusError}</p>
        )}

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
                <th className="px-6 py-3 font-medium text-xs uppercase tracking-wide">
                  Status of being reversed
                </th>
                <th className="px-6 py-3 font-medium text-xs uppercase tracking-wide"></th>
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
                  <td className="px-6 py-4 whitespace-nowrap">
                    <ReverseEngineeringStatusSelect
                      value={device.reverseEngineeringStatus}
                      saving={savingStatusIds.has(device.deviceId)}
                      onChange={(next) => void handleStatusChange(device, next)}
                      ariaLabel={`Status of being reversed for ${device.name}`}
                    />
                  </td>
                  <td className="px-6 py-4 text-right space-x-3">
                    <button
                      onClick={() => openViewModal(device)}
                      disabled={uploading}
                      className="text-blue-600 hover:text-blue-700 disabled:opacity-50 text-xs font-medium transition-colors"
                    >
                      View Firmware
                    </button>
                    <button
                      onClick={() => openUploadModal(device)}
                      disabled={uploading}
                      className="text-blue-600 hover:text-blue-700 disabled:opacity-50 text-xs font-medium transition-colors"
                    >
                      Upload Firmware
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Device modal */}
      {isAddOpen && (
        <div
          className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeAddModal();
          }}
        >
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
            <div className="mb-6">
              <h2 className="text-xl font-bold text-slate-800 tracking-tight">Add Device</h2>
              <p className="text-slate-400 text-sm mt-1">
                Register a new device for vulnerability analysis
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                  Device Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={submitting}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
                  placeholder="Philips IntelliVue MX800"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                  Device Type
                </label>
                <input
                  type="text"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  disabled={submitting}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
                  placeholder="Patient Monitor"
                />
              </div>

              {submitError && (
                <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{submitError}</p>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeAddModal}
                  disabled={submitting}
                  className="flex-1 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-600 border border-slate-200 py-2.5 rounded-lg text-sm font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || !isFormValid}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2.5 rounded-lg text-sm font-medium transition-colors"
                >
                  {submitting ? "Creating…" : "Add Device"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Upload Firmware modal */}
      {uploadDevice && (
        <div
          className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeUploadModal();
          }}
        >
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
            <div className="mb-6">
              <h2 className="text-xl font-bold text-slate-800 tracking-tight">Upload Firmware</h2>
              <p className="text-slate-400 text-sm mt-1">{uploadDevice.name}</p>
            </div>

            {uploadStage === "complete" && uploadedVersion ? (
              <div className="space-y-4">
                <p className="text-xs text-emerald-700 bg-emerald-50 px-3 py-2 rounded-lg">
                  Firmware {uploadedVersion} is ready.
                </p>
                <button
                  type="button"
                  onClick={closeUploadModal}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg text-sm font-medium transition-colors"
                >
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleUploadSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                    Version
                  </label>
                  <input
                    type="text"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    disabled={uploading}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
                    placeholder="v1.0.0"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                    Firmware File
                  </label>
                  <input
                    key={fileInputKey}
                    type="file"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    disabled={uploading}
                    className="w-full text-sm text-slate-600 disabled:opacity-50"
                  />
                  <p className="text-xs text-slate-400 mt-1">Maximum size: 5 GiB</p>
                </div>

                {uploadStage && (
                  <p className="text-xs text-blue-600 bg-blue-50 px-3 py-2 rounded-lg">
                    {uploadStageLabel(uploadStage, uploadProgress)}
                  </p>
                )}

                {uploadError && (
                  <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{uploadError}</p>
                )}

                <div className="flex items-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={closeUploadModal}
                    disabled={uploading}
                    className="flex-1 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-600 border border-slate-200 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={uploading || !isUploadFormValid}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    {uploading ? uploadStageLabel(uploadStage ?? "hashing", uploadProgress) : "Upload"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {viewDevice && (
        <FirmwareListModal device={viewDevice} onClose={closeViewModal} />
      )}
    </div>
  );
}
