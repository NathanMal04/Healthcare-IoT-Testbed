import {
  MAX_FILES_PER_PRESIGN,
  completeArtifact,
  isAbortError,
  presignArtifacts,
  retryArtifact,
  sha256File,
  transferArtifact,
  type ArtifactType,
  type PresignedUpload,
} from "@/lib/artifacts";

export type QueueStage =
  | "queued"
  | "hashing"
  | "reserving"
  | "uploading"
  | "verifying"
  | "ready"
  | "failed";

export interface QueueItem {
  id: string;
  file: File;
  /** Path relative to the chosen folder, or the file name. */
  path: string;
  type: ArtifactType;
  version: string;
  stage: QueueStage;
  /** Progress of the current stage, 0..1. */
  progress: number;
  error?: string;
  sha256?: string;
  artifactId?: string;
  attemptId?: string;
}

export interface QueueOptions {
  tags: string[];
  deviceIds: string[];
}

const HASH_CONCURRENCY = 3;
const UPLOAD_CONCURRENCY = 3;
// Presign calls carry at most 100 files and roughly 2 GiB, so large files
// start uploading without waiting for a long run of hashing.
const CHUNK_MAX_BYTES = 2 * 1024 ** 3;
// Hashing stops running ahead once this many presigned files are waiting to
// upload, so presigned POSTs (valid for an hour) are used well before expiry.
const MAX_WAITING_UPLOADS = 100;

function createLimiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Uploads many files as one upload batch: hashes them, registers them with
 * /artifacts/presign in chunks, sends them to S3 and completes them, with a
 * few files in flight at each stage. Per-file failures don't stop the rest,
 * and `start()` can be called again to retry only the failed files.
 */
export class UploadQueue {
  private items: QueueItem[];
  private readonly options: QueueOptions;
  private uploadBatchId?: string;
  private controller?: AbortController;
  private listeners = new Set<(items: QueueItem[]) => void>();
  private emitTimer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(items: QueueItem[], options: QueueOptions) {
    this.items = items;
    this.options = options;
  }

  get isRunning() {
    return this.running;
  }

  get batchId() {
    return this.uploadBatchId;
  }

  subscribe(listener: (items: QueueItem[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.items.map((item) => ({ ...item })));
    return () => this.listeners.delete(listener);
  }

  cancel() {
    this.controller?.abort();
  }

  /** Uploads every item that is queued or failed. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;

    const targets = this.items.filter((i) => i.stage === "queued" || i.stage === "failed");
    for (const item of targets) this.update(item, { stage: "queued", progress: 0, error: undefined });

    const uploadLimit = createLimiter(UPLOAD_CONCURRENCY);
    const uploads: Promise<void>[] = [];
    let waitingUploads = 0;

    const scheduleUpload = (item: QueueItem, presigned: () => Promise<PresignedUpload>) => {
      waitingUploads++;
      uploads.push(
        uploadLimit(async () => {
          waitingUploads--;
          await this.upload(item, presigned, signal);
        })
      );
    };

    try {
      // Items that were already registered only need a new upload attempt.
      for (const item of targets.filter((i) => i.artifactId && i.attemptId)) {
        scheduleUpload(item, () => retryArtifact(item.artifactId!, item.attemptId!));
      }

      const hashLimit = createLimiter(HASH_CONCURRENCY);
      for (const chunk of this.chunks(targets.filter((i) => !i.artifactId))) {
        while (waitingUploads >= MAX_WAITING_UPLOADS && !signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (signal.aborted) break;

        await Promise.all(chunk.map((item) => hashLimit(() => this.hash(item, signal))));
        const hashed = chunk.filter((item) => item.sha256 && item.stage === "hashing");
        if (!hashed.length) continue;

        const presigned = await this.presign(hashed, signal);
        for (const [item, result] of presigned) scheduleUpload(item, async () => result);
      }

      await Promise.all(uploads);
    } finally {
      for (const item of targets) {
        if (item.stage !== "ready" && item.stage !== "failed") {
          this.update(item, { stage: "failed", error: "Cancelled" });
        }
      }
      this.running = false;
      this.flush();
    }
  }

  private *chunks(items: QueueItem[]): Generator<QueueItem[]> {
    let chunk: QueueItem[] = [];
    let bytes = 0;
    for (const item of items) {
      if (chunk.length && (chunk.length >= MAX_FILES_PER_PRESIGN || bytes + item.file.size > CHUNK_MAX_BYTES)) {
        yield chunk;
        chunk = [];
        bytes = 0;
      }
      chunk.push(item);
      bytes += item.file.size;
    }
    if (chunk.length) yield chunk;
  }

  private async hash(item: QueueItem, signal: AbortSignal) {
    if (signal.aborted) return;
    try {
      this.update(item, { stage: "hashing", progress: 0 });
      const sha256 =
        item.sha256 ??
        (await sha256File(item.file, (done) => this.update(item, { progress: done / item.file.size }), signal));
      this.update(item, { sha256, progress: 1 });
    } catch (err) {
      this.fail(item, err);
    }
  }

  private async presign(items: QueueItem[], signal: AbortSignal): Promise<[QueueItem, PresignedUpload][]> {
    for (const item of items) this.update(item, { stage: "reserving", progress: 0 });
    if (signal.aborted) return [];

    try {
      const response = await presignArtifacts({
        uploadBatchId: this.uploadBatchId,
        tags: this.options.tags,
        deviceIds: this.options.deviceIds,
        files: items.map((item) => ({
          clientRef: item.id,
          originalFilename: item.path,
          sizeBytes: item.file.size,
          sha256: item.sha256!,
          type: item.type,
          version: item.type === "firmware" ? item.version.trim() : undefined,
        })),
      });
      this.uploadBatchId = response.uploadBatchId;

      const byId = new Map(items.map((item) => [item.id, item]));
      const accepted: [QueueItem, PresignedUpload][] = [];
      for (const result of response.results) {
        const item = byId.get(result.clientRef);
        if (!item) continue;
        if (result.ok) {
          this.update(item, { artifactId: result.artifactId, attemptId: result.attemptId });
          accepted.push([item, result]);
        } else {
          this.update(item, { stage: "failed", error: result.error });
        }
      }
      return accepted;
    } catch (err) {
      for (const item of items) this.fail(item, err);
      return [];
    }
  }

  private async upload(item: QueueItem, presigned: () => Promise<PresignedUpload>, signal: AbortSignal) {
    if (signal.aborted) return;
    try {
      this.update(item, { stage: "uploading", progress: 0, error: undefined });
      const upload = await presigned();
      this.update(item, { attemptId: upload.attemptId });

      const attemptId = await transferArtifact(
        item.file,
        upload,
        (sent) => this.update(item, { progress: sent / item.file.size }),
        signal
      );
      this.update(item, { attemptId, progress: 1 });

      await completeArtifact(
        upload.artifactId,
        attemptId,
        () => this.update(item, { stage: "verifying", progress: 0 }),
        signal
      );
      this.update(item, { stage: "ready", progress: 1 });
    } catch (err) {
      this.fail(item, err);
    }
  }

  private fail(item: QueueItem, err: unknown) {
    const message = isAbortError(err) ? "Cancelled" : err instanceof Error ? err.message : "Upload failed";
    this.update(item, { stage: "failed", error: message });
  }

  private update(item: QueueItem, patch: Partial<QueueItem>) {
    Object.assign(item, patch);
    this.scheduleEmit();
  }

  private scheduleEmit() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => this.flush(), 150);
  }

  private flush() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
    const snapshot = this.items.map((item) => ({ ...item }));
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
