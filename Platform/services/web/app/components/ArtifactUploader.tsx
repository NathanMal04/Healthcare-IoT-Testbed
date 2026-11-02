"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImageIcon } from "lucide-react";
import {
  ARTIFACT_TYPES,
  ARTIFACT_TYPE_LABELS,
  MAX_ARTIFACT_SIZE_BYTES,
  formatBytes,
  stagedArtifactType,
  type ArtifactType,
  type StoredArtifactType,
} from "@/lib/artifacts";
import {
  IMAGE_ACCEPT,
  IMAGE_TYPE,
  capturedAtError,
  checkImageFile,
  fileIdentity,
  imageDescriptionError,
  imageTitleError,
  todayInput,
} from "@/lib/images";
import { UploadQueue, type QueueItem, type QueueStage } from "@/lib/uploadQueue";
import type { Device } from "@/lib/devices";
import { useScopeLock } from "@/context/WorkspaceContext";
import { UploadCloud } from "lucide-react";
import { Alert, cardClass, inputClass as sharedInputClass, labelClass, primaryButton, secondaryButton } from "@/app/components/ui";

interface ArtifactUploaderProps {
  /** The devices of the current scope; the upload's scope comes from the ones chosen. */
  devices: Device[];
  /**
   * In a workspace, files must be linked to at least one of its devices: the
   * backend puts an upload in the workspace of its devices, and an upload
   * without devices would be personal.
   */
  requireDevice?: boolean;
  /**
   * Set when the upload started from a device's page: every file is linked
   * to it, and it can't be unchecked.
   */
  fixedDevice?: Device;
  /**
   * Set when the upload started from a category: every file gets this type,
   * and it can't be changed. Without it each file's type is guessed from its
   * name and can be changed. "image" (a device's Images tab) only accepts
   * JPEG, PNG and WebP files up to 25 MiB, checked by their bytes, and asks
   * for an optional title, description and capture date per image.
   */
  fixedType?: StoredArtifactType;
  /**
   * Called when a run of uploads ends, with the batch id if one was created
   * and how many files ended failed.
   */
  onFinished: (uploadBatchId: string | undefined, failedCount: number) => void;
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
  hashing: "text-brand-600",
  reserving: "text-brand-600",
  uploading: "text-brand-600",
  verifying: "text-brand-600",
  ready: "text-emerald-700",
  failed: "text-red-600",
};

const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/=+@-]{0,63}$/;
const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

let nextItemId = 0;

function toQueueItem(file: File, path: string, fixedType?: StoredArtifactType): QueueItem {
  return {
    id: `f${nextItemId++}`,
    file,
    path,
    type: stagedArtifactType(file.name, fixedType),
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

export default function ArtifactUploader({
  devices,
  requireDevice = false,
  fixedDevice,
  fixedType,
  onFinished,
}: ArtifactUploaderProps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [tagsInput, setTagsInput] = useState("");
  const [deviceIds, setDeviceIds] = useState<string[]>(fixedDevice ? [fixedDevice.deviceId] : []);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Images: a capture date for every image that doesn't set its own.
  const [sharedCapturedAt, setSharedCapturedAt] = useState("");
  const imageMode = fixedType === IMAGE_TYPE;

  const [queue, setQueue] = useState<UploadQueue | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Images: the files staged or being checked (by fileIdentity), updated
  // synchronously so rapid selections can't stage one file twice, and a
  // generation that changes when the staging ends (upload started or
  // cleared), so a check that finishes later can't change the list.
  const imageIdentitiesRef = useRef(new Set<string>());
  const stagingGenerationRef = useRef(0);
  const startedRef = useRef(false);

  // Staged items live in React state until the upload starts; after that the
  // queue owns them and pushes snapshots back here.
  const started = queue !== null;

  // The upload belongs to the current scope; keep it from changing mid-upload.
  useScopeLock(running);

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

  async function addImages(files: { file: File; path: string }[]) {
    const generation = stagingGenerationRef.current;
    const identities = imageIdentitiesRef.current;
    const rejected: string[] = [];
    // Reserve every new file before the first await, so a second selection
    // made while these are being checked sees them as already added.
    const candidates: { file: File; path: string; identity: string }[] = [];
    for (const { file, path } of files) {
      const identity = fileIdentity(file, path);
      if (identities.has(identity)) rejected.push(`${path} (already added)`);
      else {
        identities.add(identity);
        candidates.push({ file, path, identity });
      }
    }

    const accepted: QueueItem[] = [];
    for (const { file, path, identity } of candidates) {
      // The format comes from the file's bytes, not its name or the
      // browser's guess: the backend checks the same signature.
      let check: Awaited<ReturnType<typeof checkImageFile>>;
      try {
        check = await checkImageFile(file);
      } catch {
        // e.g. the file was moved or deleted after it was chosen.
        check = { ok: false, reason: "couldn't be read" };
      }
      if (!check.ok) {
        identities.delete(identity);
        rejected.push(`${path} (${check.reason})`);
        continue;
      }
      accepted.push({ ...toQueueItem(file, path, IMAGE_TYPE), image: { mimeType: check.mimeType } });
    }

    if (generation !== stagingGenerationRef.current) {
      // The staging ended while these were checked: never change the list
      // the upload is using. After a start, say what wasn't included.
      if (startedRef.current && accepted.length) {
        setSkipped((current) => [
          ...current,
          ...accepted.map((item) => `${item.path} (chosen after the upload started; add it to a new upload)`),
        ]);
      }
      return;
    }
    setItems((current) => [...current, ...accepted]);
    setSkipped((current) => [...current, ...rejected]);
  }

  function addFiles(files: { file: File; path: string }[]) {
    if (started) return;
    if (imageMode) {
      void addImages(files);
      return;
    }
    const accepted: QueueItem[] = [];
    const rejected: string[] = [];
    for (const { file, path } of files) {
      if (file.size === 0) rejected.push(`${path} (empty)`);
      else if (file.size > MAX_ARTIFACT_SIZE_BYTES) rejected.push(`${path} (over 5 GiB)`);
      else accepted.push(toQueueItem(file, path, fixedType));
    }
    setItems((current) => [...current, ...accepted]);
    setSkipped((current) => [...current, ...rejected]);
  }

  function updateStaged(id: string, patch: Partial<Pick<QueueItem, "type" | "version">>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function updateImage(id: string, patch: { title?: string; description?: string; capturedAt?: string }) {
    setItems((current) =>
      current.map((item) => (item.id === id && item.image ? { ...item, image: { ...item.image, ...patch } } : item))
    );
  }

  function removeStaged(id: string) {
    const removed = items.find((item) => item.id === id);
    if (removed) imageIdentitiesRef.current.delete(fileIdentity(removed.file, removed.path));
    setItems((current) => current.filter((item) => item.id !== id));
  }

  function reset() {
    if (running) return;
    stagingGenerationRef.current++;
    startedRef.current = false;
    imageIdentitiesRef.current = new Set();
    setQueue(null);
    setItems([]);
    setSkipped([]);
    setFormError(null);
    setSharedCapturedAt("");
  }

  function validate(): string | null {
    if (!items.length) return "Add at least one file";
    if (requireDevice && !deviceIds.length) {
      return "Choose at least one workspace device: files join the workspace through their devices";
    }
    const tags = parseTags(tagsInput);
    if (tags.length > 20) return "At most 20 tags";
    const badTag = tags.find((t) => !TAG_PATTERN.test(t));
    if (badTag) return `Invalid tag "${badTag}": use letters, digits and . _ : / = + @ -`;
    const missingVersion = items.find(
      (item) => item.type === "firmware" && !VERSION_PATTERN.test(item.version.trim())
    );
    if (missingVersion) return `Firmware needs a version: ${missingVersion.path}`;
    if (imageMode) {
      const sharedError = capturedAtError(sharedCapturedAt);
      if (sharedError) return sharedError;
      for (const item of items) {
        const error =
          imageTitleError(item.image?.title ?? "") ??
          imageDescriptionError(item.image?.description ?? "") ??
          capturedAtError(item.image?.capturedAt ?? "");
        if (error) return `${item.path}: ${error}`;
      }
    }
    return null;
  }

  async function run(target: UploadQueue) {
    setRunning(true);
    try {
      await target.start();
    } finally {
      setRunning(false);
      onFinished(target.batchId, target.failedCount);
    }
  }

  function startUpload() {
    const error = validate();
    setFormError(error);
    if (error) return;

    const created = new UploadQueue(
      items.map((item) => ({
        ...item,
        version: item.version.trim(),
        ...(item.image && {
          image: { ...item.image, capturedAt: item.image.capturedAt || sharedCapturedAt || undefined },
        }),
      })),
      { tags: parseTags(tagsInput), deviceIds }
    );
    // From here the queue owns the files; late image checks can't add any.
    stagingGenerationRef.current++;
    startedRef.current = true;
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

  const inputClass = sharedInputClass;

  return (
    <div className={`${cardClass} p-5 space-y-5`}>
      <div>
        <h2 className="text-sm font-semibold text-slate-800">
          {fixedType ? `Upload ${ARTIFACT_TYPE_LABELS[fixedType].single}` : "Upload files"}
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          {imageMode
            ? "JPEG, PNG or WebP photographs, up to 25 MiB each. Title, description and capture date are optional and can be changed later."
            : fixedType
              ? `Every file is uploaded as ${ARTIFACT_TYPE_LABELS[fixedType].single}, up to 5 GiB each.`
              : "Firmware, pcaps, logs, binaries, kernel modules, PDF reports or anything else, up to 5 GiB each."}{" "}
          Files uploaded together form one upload batch.
        </p>
        {fixedDevice && (
          <p className="text-xs text-slate-600 mt-2">
            Linked to device{" "}
            <span className="font-medium text-brand-700 bg-brand-50 px-1.5 py-0.5 rounded-md">{fixedDevice.name}</span>
          </p>
        )}
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
            dragging ? "border-brand-500 bg-brand-50" : "border-line-strong bg-surface-muted"
          }`}
        >
          <UploadCloud className={`mx-auto h-8 w-8 ${dragging ? "text-brand-600" : "text-slate-400"}`} aria-hidden="true" />
          <p className="text-sm text-slate-600 mt-2">
            <span className="font-medium text-slate-800">
              {imageMode ? "Drop images or folders here" : "Drop files or folders here"}
            </span>
            , or choose them below
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <button type="button" onClick={() => fileInputRef.current?.click()} className={secondaryButton}>
              {imageMode ? "Choose images" : "Choose files"}
            </button>
            <button type="button" onClick={() => folderInputRef.current?.click()} className={secondaryButton}>
              Choose folder
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={imageMode ? IMAGE_ACCEPT : undefined}
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
        <Alert tone="warning">
          Skipped {skipped.length} file{skipped.length === 1 ? "" : "s"}: {skipped.slice(0, 5).join(", ")}
          {skipped.length > 5 ? ", …" : ""}
        </Alert>
      )}

      {items.length > 0 && (
        <>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>
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
              <label className={labelClass}>
                {requireDevice ? "Workspace devices (all files, at least one)" : "Devices (all files, optional)"}
              </label>
              {devices.length === 0 ? (
                <p className="text-xs text-slate-400 py-2">
                  {requireDevice ? "Add a device to this workspace first." : "No devices yet."}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {devices.map((device) => {
                    const checked = deviceIds.includes(device.deviceId);
                    const fixed = device.deviceId === fixedDevice?.deviceId;
                    return (
                      <label
                        key={device.deviceId}
                        title={fixed ? "This upload started from this device's page" : undefined}
                        className={`text-xs px-2.5 py-1.5 rounded-lg border cursor-pointer ${
                          checked ? "border-brand-500 bg-brand-50 text-brand-700" : "border-line text-slate-600 hover:border-line-strong"
                        } ${started ? "opacity-50 cursor-not-allowed" : fixed ? "cursor-default" : ""}`}
                      >
                        <input
                          type="checkbox"
                          className="hidden"
                          checked={checked}
                          disabled={started || fixed}
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
            {imageMode && (
              <div>
                <label className={labelClass} htmlFor="uploader-captured-at">
                  Captured on (all images, optional)
                </label>
                <input
                  id="uploader-captured-at"
                  type="date"
                  value={sharedCapturedAt}
                  min="1970-01-01"
                  max={todayInput()}
                  onChange={(e) => setSharedCapturedAt(e.target.value)}
                  disabled={started}
                  className={inputClass}
                />
                <p className="text-xs text-slate-400 mt-1">When the photographs were taken; an image&apos;s own date wins.</p>
              </div>
            )}
          </div>

          {started && (
            <div>
              <div className="flex justify-between text-xs text-slate-600 mb-1">
                <span>
                  {summary.counts.ready} of {items.length} ready
                  {summary.counts.failed > 0 && `, ${summary.counts.failed} failed`}
                </span>
                <span>
                  {formatBytes(summary.doneBytes)} / {formatBytes(summary.totalBytes)}
                </span>
              </div>
              <div className="h-2 bg-surface-sunken rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-600 transition-all"
                  style={{ width: `${summary.totalBytes ? (summary.doneBytes / summary.totalBytes) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          {imageMode ? (
            <StagedImageList
              items={items}
              started={started}
              sharedCapturedAt={sharedCapturedAt}
              onChange={updateImage}
              onRemove={removeStaged}
            />
          ) : (
            <div className="max-h-96 overflow-auto border border-line rounded-lg">
              <table className="w-full text-sm min-w-[36rem]">
                <thead className="sticky top-0 bg-surface-muted">
                  <tr className="text-left text-slate-500">
                    <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">File</th>
                    <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Size</th>
                    <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Type</th>
                    <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Version</th>
                    <th className="px-3 py-2 font-medium text-xs uppercase tracking-wide">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-t border-line/70">
                      <td className="px-3 py-2 text-slate-700 break-all">{item.path}</td>
                      <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{formatBytes(item.file.size)}</td>
                      <td className="px-3 py-2">
                        {fixedType ? (
                          <span
                            className="text-xs font-medium text-brand-700 bg-brand-50 px-1.5 py-0.5 rounded-md whitespace-nowrap"
                            title="Set by the category this upload started from"
                          >
                            {ARTIFACT_TYPE_LABELS[item.type].single}
                          </span>
                        ) : (
                          <select
                            value={item.type}
                            disabled={started}
                            onChange={(e) => updateStaged(item.id, { type: e.target.value as ArtifactType })}
                            className="text-sm border border-line rounded-md px-2 py-1 bg-white disabled:opacity-60"
                          >
                            {ARTIFACT_TYPES.map((type) => (
                              <option key={type} value={type}>
                                {ARTIFACT_TYPE_LABELS[type].single}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {item.type === "firmware" ? (
                          <input
                            type="text"
                            value={item.version}
                            disabled={started}
                            onChange={(e) => updateStaged(item.id, { version: e.target.value })}
                            placeholder="v1.0.0"
                            className="w-28 text-sm border border-line rounded-md px-2 py-1 disabled:opacity-60"
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
          )}

          {formError && <Alert tone="error">{formError}</Alert>}

          <div className="flex items-center justify-end gap-3">
            {!started && (
              <>
                <button
                  type="button"
                  onClick={reset}
                  className={secondaryButton}
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={startUpload}
                  className={primaryButton}
                >
                  Upload {items.length} {imageMode ? "image" : "file"}
                  {items.length === 1 ? "" : "s"}
                </button>
              </>
            )}
            {started && running && (
              <button
                type="button"
                onClick={() => queue?.cancel()}
                className={secondaryButton}
              >
                Cancel
              </button>
            )}
            {started && !running && summary.counts.failed > 0 && (
              <button
                type="button"
                onClick={retryFailed}
                className={primaryButton}
              >
                Retry {summary.counts.failed} failed
              </button>
            )}
            {started && !running && (
              <button
                type="button"
                onClick={reset}
                className={secondaryButton}
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

/**
 * A staged image's local preview. The object URL is created only once the
 * preview scrolls near the visible part of the list, so staging many large
 * photos doesn't decode them all, and it is released on unmount. Nothing is
 * uploaded here.
 */
function LocalPreview({ file }: { file: File }) {
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [visible, file]);

  return (
    <span
      ref={boxRef}
      className="h-16 w-16 shrink-0 rounded-lg border border-line bg-surface-sunken overflow-hidden flex items-center justify-center"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview, not an optimisable asset
        <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
      ) : (
        <ImageIcon className="h-5 w-5 text-slate-400" aria-hidden="true" />
      )}
    </span>
  );
}

/** The image upload's staged files: preview, metadata fields and status per image. */
function StagedImageList({
  items,
  started,
  sharedCapturedAt,
  onChange,
  onRemove,
}: {
  items: QueueItem[];
  started: boolean;
  sharedCapturedAt: string;
  onChange: (id: string, patch: { title?: string; description?: string; capturedAt?: string }) => void;
  onRemove: (id: string) => void;
}) {
  const fieldClass =
    "w-full text-sm border border-line rounded-md px-2 py-1.5 bg-white disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500";
  return (
    <ul className="max-h-[28rem] overflow-auto border border-line rounded-lg divide-y divide-line/70">
      {items.map((item) => {
        const fieldId = `staged-${item.id}`;
        return (
          <li key={item.id} className="p-3 flex flex-col sm:flex-row gap-3">
            <div className="flex items-start gap-3 sm:w-56 shrink-0 min-w-0">
              <LocalPreview file={item.file} />
              <div className="min-w-0">
                <p className="text-sm text-slate-700 break-all">{item.path}</p>
                <p className="text-xs text-slate-500">
                  {formatBytes(item.file.size)} · {item.image?.mimeType.replace("image/", "").toUpperCase()}
                </p>
                <div className="mt-1">
                  {started ? (
                    <>
                      <span className={`text-xs font-medium ${STAGE_STYLES[item.stage]}`}>
                        {STAGE_LABELS[item.stage]}
                        {(item.stage === "hashing" || item.stage === "uploading") && ` ${Math.floor(item.progress * 100)}%`}
                      </span>
                      {item.error && <p className="text-xs text-red-600">{item.error}</p>}
                    </>
                  ) : (
                    <button type="button" onClick={() => onRemove(item.id)} className="text-xs text-slate-400 hover:text-red-600">
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="sm:col-span-2">
                <label htmlFor={`${fieldId}-title`} className="sr-only">
                  Title for {item.path}
                </label>
                <input
                  id={`${fieldId}-title`}
                  type="text"
                  value={item.image?.title ?? ""}
                  onChange={(e) => onChange(item.id, { title: e.target.value })}
                  disabled={started}
                  placeholder={`Title (default: ${item.path.split("/").pop()})`}
                  maxLength={200}
                  className={fieldClass}
                />
              </div>
              <div>
                <label htmlFor={`${fieldId}-captured`} className="sr-only">
                  Capture date for {item.path}
                </label>
                <input
                  id={`${fieldId}-captured`}
                  type="date"
                  value={item.image?.capturedAt ?? ""}
                  min="1970-01-01"
                  max={todayInput()}
                  onChange={(e) => onChange(item.id, { capturedAt: e.target.value })}
                  disabled={started}
                  title={sharedCapturedAt && !item.image?.capturedAt ? `Uses ${sharedCapturedAt} unless set here` : "Capture date"}
                  className={fieldClass}
                />
              </div>
              <div className="sm:col-span-3">
                <label htmlFor={`${fieldId}-description`} className="sr-only">
                  Description for {item.path}
                </label>
                <textarea
                  id={`${fieldId}-description`}
                  value={item.image?.description ?? ""}
                  onChange={(e) => onChange(item.id, { description: e.target.value })}
                  disabled={started}
                  placeholder="Description (optional)"
                  rows={2}
                  maxLength={2000}
                  className={`${fieldClass} resize-y`}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
