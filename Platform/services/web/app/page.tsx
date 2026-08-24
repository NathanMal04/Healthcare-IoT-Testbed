"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { getDevices, createDevice, type Device } from "@/lib/devices";
import {
  sha256Hex,
  presignFirmware,
  uploadFirmwareToS3,
  completeFirmware,
  type CompleteFirmwareResponse,
} from "@/lib/firmware";
import FirmwareListModal from "@/app/components/FirmwareListModal";

const MAX_FIRMWARE_SIZE_BYTES = 26214400; // 25 MiB

type UploadStage = "hashing" | "reserving" | "uploading" | "verifying" | "complete";

const UPLOAD_STAGE_LABELS: Record<UploadStage, string> = {
  hashing: "Hashing...",
  reserving: "Reserving upload...",
  uploading: "Uploading...",
  verifying: "Verifying...",
  complete: "Complete",
};

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
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<CompleteFirmwareResponse | null>(null);

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

  function openUploadModal(device: Device) {
    if (uploading) return;
    closeViewModal();
    setUploadDevice(device);
    setVersion("");
    setFile(null);
    setFileInputKey((k) => k + 1);
    setUploadStage(null);
    setUploadError(null);
    setUploadResult(null);
  }

  function closeUploadModal() {
    if (uploading) return;
    setUploadDevice(null);
    setVersion("");
    setFile(null);
    setFileInputKey((k) => k + 1);
    setUploadStage(null);
    setUploadError(null);
    setUploadResult(null);
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
    if (file.size > MAX_FIRMWARE_SIZE_BYTES) {
      setUploadError("File exceeds the 25 MiB limit");
      return;
    }

    setUploading(true);
    setUploadError(null);
    setUploadResult(null);

    try {
      setUploadStage("hashing");
      const sha256 = await sha256Hex(file);

      setUploadStage("reserving");
      const presign = await presignFirmware(uploadDevice.deviceId, {
        version: trimmedVersion,
        originalFilename: file.name,
        sizeBytes: file.size,
        sha256,
      });

      setUploadStage("uploading");
      await uploadFirmwareToS3(presign.upload, file);

      setUploadStage("verifying");
      const completed = await completeFirmware(
        uploadDevice.deviceId,
        trimmedVersion,
        presign.attemptId
      );

      setUploadResult(completed);
      setUploadStage("complete");
      setVersion("");
      setFile(null);
      setFileInputKey((k) => k + 1);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
      setUploadStage(null);
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

            {uploadStage === "complete" && uploadResult ? (
              <div className="space-y-4">
                <p className="text-xs text-emerald-700 bg-emerald-50 px-3 py-2 rounded-lg">
                  Firmware {uploadResult.version} is {uploadResult.status}.
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
                  <p className="text-xs text-slate-400 mt-1">Maximum size: 25 MiB</p>
                </div>

                {uploadStage && (
                  <p className="text-xs text-blue-600 bg-blue-50 px-3 py-2 rounded-lg">
                    {UPLOAD_STAGE_LABELS[uploadStage]}
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
                    {uploading ? UPLOAD_STAGE_LABELS[uploadStage ?? "hashing"] : "Upload"}
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
