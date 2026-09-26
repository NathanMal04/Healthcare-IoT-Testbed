"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ARTIFACT_TYPES,
  MAX_ARTIFACT_SIZE_BYTES,
  formatBytes,
  guessArtifactType,
  type ArtifactType,
} from "@/lib/artifacts";
import { UploadQueue, type QueueItem, type QueueStage } from "@/lib/uploadQueue";
import type { Device } from "@/lib/devices";

interface ArtifactUploaderProps {
  devices: Device[];
  /** Called when a run of uploads ends, with the batch id if one was created. */
  onFinished: (uploadBatchId: string | undefined) => void;
}

const STAGE_LABELS: Record<QueueStage, string> = {
  queued: "Queued",
  hashing: "Hashing",
  reserving: "Reserving",
  uploading: "Uploading",
  verifying: "Verifying",
  ready: "Ready",
  failed: "Failed",
};

const STAGE_STYLES: Record<QueueStage, string> = {
  queued: "text-slate-500",
  hashing: "text-blue-600",
  reserving: "text-blue-600",
  uploading: "text-blue-600",
  verifying: "text-blue-600",
  ready: "text-emerald-700",
  failed: "text-red-600",
};

const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/=+@-]{0,63}$/;
const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

let nextItemId = 0;

function toQueueItem(file: File, path: string): QueueItem {
  return {
    id: `f${nextItemId++}`,
    file,
    path,
    type: guessArtifactType(file.name),
    version: "",
    stage: "queued",
    progress: 0,
  };
}

function parseTags(raw: string): string[] {
  return Array.from(new Set(raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)));
}

/** Reads every file in a dropped folder, keeping paths relative to it. */
async function filesFromDrop(dataTransfer: DataTransfer): Promise<{ file: File; path: string }[]> {
  const entries = Array.from(dataTransfer.items)
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);

  if (!entries.length) {
    return Array.from(dataTransfer.files).map((file) => ({ file, path: file.name }));
  }

  const results: { file: File; path: string }[] = [];
  async function walk(entry: FileSystemEntry, prefix: string) {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject)
      );
      results.push({ file, path: `${prefix}${entry.name}` });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns results in batches until it returns an empty list.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject)
        );
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  }
  for (const entry of entries) await walk(entry, "");
  return results;
}

export default function ArtifactUploader({ devices, onFinished }: ArtifactUploaderProps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [tagsInput, setTagsInput] = useState("");
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [queue, setQueue] = useState<UploadQueue | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Staged items live in React state until the upload starts; after that the
  // queue owns them and pushes snapshots back here.
  const started = queue !== null;

  useEffect(() => {
    // webkitdirectory isn't in React's attribute types.
    folderInputRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  function addFiles(files: { file: File; path: string }[]) {
    if (started) return;
    const accepted: QueueItem[] = [];
    const rejected: string[] = [];
    for (const { file, path } of files) {
      if (file.size === 0) rejected.push(`${path} (empty)`);
      else if (file.size > MAX_ARTIFACT_SIZE_BYTES) rejected.push(`${path} (over 5 GiB)`);
      else accepted.push(toQueueItem(file, path));
    }
    setItems((current) => [...current, ...accepted]);
    setSkipped((current) => [...current, ...rejected]);
  }

  function updateStaged(id: string, patch: Partial<Pick<QueueItem, "type" | "version">>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function removeStaged(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
  }

  function reset() {
    if (running) return;
    setQueue(null);
    setItems([]);
    setSkipped([]);
    setFormError(null);
  }

  function validate(): string | null {
    if (!items.length) return "Add at least one file";
    const tags = parseTags(tagsInput);
    if (tags.length > 20) return "At most 20 tags";
    const badTag = tags.find((t) => !TAG_PATTERN.test(t));
    if (badTag) return `Invalid tag "${badTag}": use letters, digits and . _ : / = + @ -`;
    const missingVersion = items.find(
      (item) => item.type === "firmware" && !VERSION_PATTERN.test(item.version.trim())
    );
    if (missingVersion) return `Firmware needs a version: ${missingVersion.path}`;
    return null;
  }

  async function run(target: UploadQueue) {
    setRunning(true);
    try {
      await target.start();
    } finally {
      setRunning(false);
      onFinished(target.batchId);
    }
  }

  function startUpload() {
    const error = validate();
    setFormError(error);
    if (error) return;

    const created = new UploadQueue(
      items.map((item) => ({ ...item, version: item.version.trim() })),
      { tags: parseTags(tagsInput), deviceIds }
    );
    setQueue(created);
    created.subscribe(setItems);
    void run(created);
  }

  function retryFailed() {
    if (queue && !running) void run(queue);
  }

  const summary = useMemo(() => {
    let totalBytes = 0;
    let doneBytes = 0;
    const counts: Record<QueueStage, number> = {
      queued: 0, hashing: 0, reserving: 0, uploading: 0, verifying: 0, ready: 0, failed: 0,
    };
    for (const item of items) {
      totalBytes += item.file.size;
      counts[item.stage]++;
      if (item.stage === "ready" || item.stage === "verifying") doneBytes += item.file.size;
      else if (item.stage === "uploading") doneBytes += item.progress * item.file.size;
    }
    return { totalBytes, doneBytes, counts };
  }, [items]);

  const inputClass =
    "w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50";

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 space-y-5">
      <div>
        <h2 className="font-semibold text-slate-700">Upload files</h2>
        <p className="text-xs text-slate-400 mt-1">
          Firmware, pcaps, logs, binaries or anything else, up to 5 GiB each. Files uploaded together
          form one upload batch.
        </p>
      </div>

      {!started && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(await filesFromDrop(e.dataTransfer));
          }}
          className={`border-2 border-dashed rounded-xl px-6 py-8 text-center transition-colors ${
            dragging ? "border-blue-400 bg-blue-50" : "border-slate-200"
          }`}
        >
          <p className="text-sm text-slate-500">Drop files or folders here</p>
          <div className="mt-3 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-sm bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg"
            >
              Choose files
            </button>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              className="text-sm bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg"
            >
              Choose folder
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []).map((file) => ({ file, path: file.name })));
              e.target.value = "";
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(
                Array.from(e.target.files ?? []).map((file) => ({
                  file,
                  path: file.webkitRelativePath || file.name,
                }))
              );
              e.target.value = "";
            }}
          />
        </div>
      )}

      {skipped.length > 0 && (
        <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
          Skipped {skipped.length} file{skipped.length === 1 ? "" : "s"}: {skipped.slice(0, 5).join(", ")}
          {skipped.length > 5 ? ", …" : ""}
        </p>
      )}

      {items.length > 0 && (
        <>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                Tags (all files)
              </label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                disabled={started}
                placeholder="lab-2, capture-day-1"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                Devices (all files, optional)
              </label>
              {devices.length === 0 ? (
                <p className="text-xs text-slate-400 py-2">No devices yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {devices.map((device) => {
                    const checked = deviceIds.includes(device.deviceId);
                    return (
                      <label
                        key={device.deviceId}
                        className={`text-xs px-2.5 py-1.5 rounded-lg border cursor-pointer ${
                          checked ? "border-blue-400 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600"
                        } ${started ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        <input
                          type="checkbox"
                          className="hidden"
                          checked={checked}
                          disabled={started}
                          onChange={() =>
                            setDeviceIds((current) =>
                              checked ? current.filter((id) => id !== device.deviceId) : [...current, device.deviceId]
                            )
                          }
                        />
                        {device.name}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {started && (
            <div>
              <div className="flex justify-between text-xs text-slate-500 mb-1">
                <span>
                  {summary.counts.ready} of {items.length} ready
                  {summary.counts.failed > 0 && `, ${summary.counts.failed} failed`}
                </span>
                <span>
                  {formatBytes(summary.doneBytes)} / {formatBytes(summary.totalBytes)}
                </span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all"
                  style={{ width: `${summary.totalBytes ? (summary.doneBytes / summary.totalBytes) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          <div className="max-h-96 overflow-auto border border-slate-100 rounded-lg">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50">
                <tr className="text-left text-slate-400">
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">File</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Size</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Type</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Version</th>
                  <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-t border-slate-50">
                    <td className="px-3 py-2 text-slate-700 break-all">{item.path}</td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{formatBytes(item.file.size)}</td>
                    <td className="px-3 py-2">
                      <select
                        value={item.type}
                        disabled={started}
                        onChange={(e) => updateStaged(item.id, { type: e.target.value as ArtifactType })}
                        className="text-sm border border-slate-200 rounded-md px-2 py-1 disabled:opacity-60"
                      >
                        {ARTIFACT_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {item.type === "firmware" ? (
                        <input
                          type="text"
                          value={item.version}
                          disabled={started}
                          onChange={(e) => updateStaged(item.id, { version: e.target.value })}
                          placeholder="v1.0.0"
                          className="w-28 text-sm border border-slate-200 rounded-md px-2 py-1 disabled:opacity-60"
                        />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {started ? (
                        <div>
                          <span className={`text-xs font-medium ${STAGE_STYLES[item.stage]}`}>
                            {STAGE_LABELS[item.stage]}
                            {(item.stage === "hashing" || item.stage === "uploading") &&
                              ` ${Math.floor(item.progress * 100)}%`}
                          </span>
                          {item.error && (
                            <p className="text-xs text-red-600 whitespace-normal max-w-xs">{item.error}</p>
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => removeStaged(item.id)}
                          className="text-xs text-slate-400 hover:text-red-600"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {formError && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{formError}</p>}

          <div className="flex items-center justify-end gap-3">
            {!started && (
              <>
                <button
                  type="button"
                  onClick={reset}
                  className="text-sm bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 px-4 py-2 rounded-lg"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={startUpload}
                  className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium"
                >
                  Upload {items.length} file{items.length === 1 ? "" : "s"}
                </button>
              </>
            )}
            {started && running && (
              <button
                type="button"
                onClick={() => queue?.cancel()}
                className="text-sm bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 px-4 py-2 rounded-lg"
              >
                Cancel
              </button>
            )}
            {started && !running && summary.counts.failed > 0 && (
              <button
                type="button"
                onClick={retryFailed}
                className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium"
              >
                Retry {summary.counts.failed} failed
              </button>
            )}
            {started && !running && (
              <button
                type="button"
                onClick={reset}
                className="text-sm bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 px-4 py-2 rounded-lg"
              >
                New upload
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
