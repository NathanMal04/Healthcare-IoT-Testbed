import { createSHA256 } from "hash-wasm";
import { apiRequest } from "@/lib/api";
import { toReverseEngineeringStatus, type ReverseEngineeringStatus } from "@/lib/reverseEngineering";

// --- Types -------------------------------------------------------------------

export const ARTIFACT_TYPES = ["firmware", "pcap", "log", "binary", "other"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type ArtifactStatus = "pending" | "verifying" | "ready" | "failed";

export const MAX_ARTIFACT_SIZE_BYTES = 5 * 1024 ** 3; // 5 GiB
export const MAX_FILES_PER_PRESIGN = 100;

export interface Artifact {
  artifactId: string;
  name: string;
  type: ArtifactType;
  origin: string | null;
  version: string | null;
  status: ArtifactStatus;
  statusReason: string | null;
  sizeBytes: number;
  sha256: string;
  originalFilename: string;
  tags: string[];
  deviceIds: string[];
  uploadBatchId: string | null;
  uploadMode: "single" | "multipart" | null;
  attemptId: string;
  createdAt: string;
  uploadedAt: string | null;
  statusUpdatedAt: string | null;
  /** Set only on workspace artifacts. */
  workspaceId?: string;
  /**
   * Reverse-engineering progress; firmware only, absent for other types.
   * Separate from `status`, which is the upload lifecycle.
   */
  reverseEngineeringStatus?: ReverseEngineeringStatus;
}

export interface ArtifactDetail extends Artifact {
  devices: { deviceId: string; name: string | null }[];
}

export interface PresignFile {
  clientRef: string;
  originalFilename: string;
  sizeBytes: number;
  sha256: string;
  type: ArtifactType;
  version?: string;
  name?: string;
}

export type UploadInstructions =
  | { mode: "single"; url: string; fields: Record<string, string> }
  | { mode: "multipart"; partSize: number; partCount: number };

export interface PresignedUpload {
  artifactId: string;
  attemptId: string;
  status: "pending";
  upload: UploadInstructions;
}

export type PresignResult =
  | ({ clientRef: string; ok: true } & PresignedUpload)
  | { clientRef: string; ok: false; status: number; error: string };

export interface PresignResponse {
  uploadBatchId: string;
  results: PresignResult[];
}

export type CompleteResult =
  | {
      artifactId: string;
      ok: true;
      attemptId: string;
      status: ArtifactStatus;
      statusReason: string | null;
      uploadedAt: string | null;
    }
  | { artifactId: string; ok: false; status: number; error: string };

export interface ArtifactPage {
  artifacts: Artifact[];
  nextToken?: string;
  batch?: { uploadBatchId: string; fileCount: number; totalBytes: number; createdAt: string };
}

export interface ListParams {
  type?: ArtifactType;
  tag?: string;
  batchId?: string;
  runId?: string;
  /** Lists a workspace's artifacts instead of Personal ones (GET /artifacts only). */
  workspaceId?: string;
  limit?: number;
  nextToken?: string;
}

// --- API ---------------------------------------------------------------------

export function presignArtifacts(request: {
  files: PresignFile[];
  tags?: string[];
  deviceIds?: string[];
  uploadBatchId?: string;
}): Promise<PresignResponse> {
  return apiRequest("POST", "/artifacts/presign", { body: request });
}

export function presignParts(
  artifactId: string,
  attemptId: string,
  parts: { partNumber: number; sha256: string }[]
): Promise<{ parts: { partNumber: number; url: string; headers: Record<string, string> }[] }> {
  return apiRequest("POST", `/artifacts/${encodeURIComponent(artifactId)}/parts`, {
    body: { attemptId, parts },
  });
}

export function retryArtifact(artifactId: string, attemptId: string): Promise<PresignedUpload> {
  return apiRequest("POST", `/artifacts/${encodeURIComponent(artifactId)}/retry`, {
    body: { attemptId },
  });
}

export function completeArtifacts(
  items: { artifactId: string; attemptId: string }[]
): Promise<{ results: CompleteResult[] }> {
  return apiRequest("POST", "/artifacts/complete", { body: { items } });
}

export function listArtifacts(params: ListParams = {}): Promise<ArtifactPage> {
  return apiRequest("GET", "/artifacts", { query: { ...params } });
}

export interface UploadBatch {
  uploadBatchId: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

export async function listUploadBatches(): Promise<UploadBatch[]> {
  return (await apiRequest<{ batches: UploadBatch[] }>("GET", "/artifacts/batches")).batches;
}

export function listDeviceArtifacts(
  deviceId: string,
  params: Omit<ListParams, "batchId"> = {}
): Promise<ArtifactPage> {
  return apiRequest("GET", `/devices/${encodeURIComponent(deviceId)}/artifacts`, {
    query: { ...params },
  });
}

export async function getArtifact(artifactId: string): Promise<ArtifactDetail> {
  const data = await apiRequest<{ artifact: ArtifactDetail }>(
    "GET",
    `/artifacts/${encodeURIComponent(artifactId)}`
  );
  return data.artifact;
}

export interface FirmwareReverseEngineeringUpdate {
  artifactId: string;
  type: "firmware";
  version: string | null;
  status: ArtifactStatus;
  reverseEngineeringStatus: ReverseEngineeringStatus;
  updatedAt: string | null;
}

/** Sets a firmware artifact's reverse-engineering status; never its upload status. */
export function updateFirmwareReverseEngineeringStatus(
  artifactId: string,
  reverseEngineeringStatus: ReverseEngineeringStatus
): Promise<FirmwareReverseEngineeringUpdate> {
  return apiRequest("PATCH", `/artifacts/${encodeURIComponent(artifactId)}`, {
    body: { reverseEngineeringStatus },
  });
}

/** The firmware's reverse-engineering status, reading a missing value as not started. */
export function firmwareReverseEngineeringStatus(artifact: Artifact): ReverseEngineeringStatus {
  return toReverseEngineeringStatus(artifact.reverseEngineeringStatus);
}

export async function getArtifactDownloadUrl(artifactId: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(
    "GET",
    `/artifacts/${encodeURIComponent(artifactId)}/download`
  );
  return data.url;
}

// --- Helpers -----------------------------------------------------------------

const TYPE_BY_EXTENSION: Record<string, ArtifactType> = {
  pcap: "pcap",
  pcapng: "pcap",
  cap: "pcap",
  log: "log",
  txt: "log",
  json: "log",
  jsonl: "log",
  csv: "log",
  bin: "firmware",
  img: "firmware",
  hex: "firmware",
  fw: "firmware",
  elf: "binary",
  so: "binary",
  o: "binary",
  exe: "binary",
  dll: "binary",
  apk: "binary",
};

/** Best guess from the file extension; the user can change it per file. */
export function guessArtifactType(filename: string): ArtifactType {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  return TYPE_BY_EXTENSION[extension] ?? "other";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return unitIndex === 0 ? `${value} ${units[unitIndex]}` : `${value.toFixed(1)} ${units[unitIndex]}`;
}

const HASH_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Streaming SHA-256 of a file (lowercase hex). Reads the file in 8 MiB
 * slices, so a 5 GiB file never has to fit in memory.
 */
export async function sha256File(
  file: Blob,
  onProgress?: (bytesHashed: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    throwIfAborted(signal);
    const chunk = await file.slice(offset, offset + HASH_CHUNK_BYTES).arrayBuffer();
    hasher.update(new Uint8Array(chunk));
    onProgress?.(Math.min(offset + HASH_CHUNK_BYTES, file.size));
  }
  return hasher.digest("hex");
}

async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- S3 transfer ---------------------------------------------------------------

class S3TransferError extends Error {
  readonly status: number;

  constructor(status: number) {
    // S3 error bodies are XML and may echo request details; only the status
    // is reported.
    super(status === 0 ? "Network error during upload" : `S3 upload failed with status ${status}`);
    this.name = "S3TransferError";
    this.status = status;
  }
}

/**
 * XHR rather than fetch, because fetch can't report upload progress.
 * Progress is reported in bytes of `payloadBytes` (the file or part), not of
 * the request body: a POST form adds a few KB of fields, which would
 * otherwise push small files far past 100%.
 */
function xhrSend(options: {
  method: "POST" | "PUT";
  url: string;
  body: FormData | Blob;
  payloadBytes: number;
  headers?: Record<string, string>;
  onProgress?: (bytesSent: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    // One upload can make hundreds of part requests on the same signal, so
    // each request removes its listener when it settles.
    const settle = (fn: () => void) => {
      options.signal?.removeEventListener("abort", abort);
      fn();
    };
    xhr.open(options.method, options.url);
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || e.total === 0) return;
      options.onProgress?.(Math.min(options.payloadBytes, Math.round((e.loaded / e.total) * options.payloadBytes)));
    };
    xhr.onload = () =>
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new S3TransferError(xhr.status));
      });
    xhr.onerror = () => settle(() => reject(new S3TransferError(0)));
    xhr.onabort = () => settle(() => reject(new DOMException("Upload cancelled", "AbortError")));
    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.send(options.body);
  });
}

/**
 * Retries network errors and 5xx responses with backoff. A 403 (expired
 * presigned URL) is retried once after `refresh` supplies a new URL.
 */
async function sendWithRetry(
  send: () => Promise<void>,
  refresh?: () => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    try {
      await send();
      return;
    } catch (err) {
      if (!(err instanceof S3TransferError)) throw err;
      if (err.status === 403 && refresh && !refreshed) {
        refreshed = true;
        await refresh();
        continue;
      }
      const retryable = err.status === 0 || err.status >= 500;
      if (!retryable || attempt >= 4) throw err;
      throwIfAborted(signal);
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

const PART_GROUP_SIZE = 20;
const PART_CONCURRENCY = 4;

/**
 * Sends the file for an upload returned by presign or retry, and returns
 * the attempt that was actually used. A single upload whose presigned POST
 * has expired is re-issued once through the retry endpoint, which starts a
 * new attempt; `onAttempt` hears about it straight away, so a caller that
 * retries later after a failure uses the current attempt.
 */
export async function transferArtifact(
  file: File,
  presigned: PresignedUpload,
  onProgress?: (bytesSent: number) => void,
  signal?: AbortSignal,
  onAttempt?: (attemptId: string) => void
): Promise<string> {
  if (presigned.upload.mode === "single") {
    let current = presigned;
    await sendWithRetry(
      () => {
        if (current.upload.mode !== "single") throw new Error("Unexpected upload mode");
        const formData = new FormData();
        for (const [key, value] of Object.entries(current.upload.fields)) {
          formData.append(key, value);
        }
        // The file field must come last; S3 ignores fields after it.
        formData.append("file", file);
        return xhrSend({
          method: "POST",
          url: current.upload.url,
          body: formData,
          payloadBytes: file.size,
          onProgress,
          signal,
        });
      },
      async () => {
        current = await retryArtifact(current.artifactId, current.attemptId);
        onAttempt?.(current.attemptId);
      },
      signal
    );
    return current.attemptId;
  }

  await transferMultipart(file, presigned, presigned.upload, onProgress, signal);
  return presigned.attemptId;
}

async function transferMultipart(
  file: File,
  presigned: PresignedUpload,
  upload: { partSize: number; partCount: number },
  onProgress?: (bytesSent: number) => void,
  signal?: AbortSignal
) {
  const { artifactId, attemptId } = presigned;
  const sentByPart = new Map<number, number>();
  const report = () => {
    let total = 0;
    sentByPart.forEach((bytes) => (total += bytes));
    onProgress?.(total);
  };
  const slice = (partNumber: number) =>
    file.slice((partNumber - 1) * upload.partSize, partNumber * upload.partSize);

  // Parts are hashed, presigned and sent in groups, so each presigned URL is
  // used within minutes of being issued and only a few parts are in memory.
  for (let first = 1; first <= upload.partCount; first += PART_GROUP_SIZE) {
    throwIfAborted(signal);
    const numbers: number[] = [];
    for (let n = first; n < first + PART_GROUP_SIZE && n <= upload.partCount; n++) numbers.push(n);

    const hashes = new Map<number, string>();
    await mapLimit(numbers, PART_CONCURRENCY, async (n) => {
      throwIfAborted(signal);
      hashes.set(n, await sha256Blob(slice(n)));
    });

    const signed = await presignParts(
      artifactId,
      attemptId,
      numbers.map((n) => ({ partNumber: n, sha256: hashes.get(n)! }))
    );

    await mapLimit(signed.parts, PART_CONCURRENCY, async (part) => {
      let current = part;
      await sendWithRetry(
        () =>
          xhrSend({
            method: "PUT",
            url: current.url,
            body: slice(part.partNumber),
            payloadBytes: slice(part.partNumber).size,
            headers: current.headers,
            onProgress: (bytes) => {
              sentByPart.set(part.partNumber, bytes);
              report();
            },
            signal,
          }),
        async () => {
          const again = await presignParts(artifactId, attemptId, [
            { partNumber: part.partNumber, sha256: hashes.get(part.partNumber)! },
          ]);
          current = again.parts[0];
        },
        signal
      );
      sentByPart.set(part.partNumber, slice(part.partNumber).size);
      report();
    });
  }
}

const VERIFY_POLL_MS = 5000;
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Completes an upload and, for multipart uploads, waits for the
 * asynchronous full-file SHA-256 check. Resolves once the artifact is
 * ready; throws with the server's reason otherwise.
 *
 * The wait polls the complete endpoint itself rather than GET: complete is
 * idempotent, reports a failed check as an error, and re-starts a check
 * that has stalled, so an upload can't sit in "verifying" forever.
 */
export async function completeArtifact(
  artifactId: string,
  attemptId: string,
  onVerifying?: () => void,
  signal?: AbortSignal
): Promise<"ready"> {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  for (let first = true; ; first = false) {
    const { results } = await completeArtifacts([{ artifactId, attemptId }]);
    const result = results[0];
    if (!result.ok) throw new Error(result.error);
    if (result.status === "ready") return "ready";
    if (result.status !== "verifying") throw new Error(`Unexpected status ${result.status}`);

    if (first) onVerifying?.();
    if (Date.now() >= deadline) {
      throw new Error("Verification is taking longer than expected; check the Artifacts page later");
    }
    await sleep(VERIFY_POLL_MS);
    throwIfAborted(signal);
  }
}

export type SingleUploadStage = "hashing" | "reserving" | "uploading" | "verifying";

/** Hash, presign, send and complete one file. Used by the firmware dialog. */
export async function uploadArtifact(
  file: File,
  options: { type: ArtifactType; version?: string; deviceIds?: string[]; tags?: string[] },
  onStage?: (stage: SingleUploadStage, progress?: number) => void
): Promise<string> {
  onStage?.("hashing", 0);
  const sha256 = await sha256File(file, (done) => onStage?.("hashing", done / file.size));

  onStage?.("reserving");
  const response = await presignArtifacts({
    files: [
      {
        clientRef: "0",
        originalFilename: file.name,
        sizeBytes: file.size,
        sha256,
        type: options.type,
        version: options.version,
      },
    ],
    deviceIds: options.deviceIds,
    tags: options.tags,
  });
  const result = response.results[0];
  if (!result.ok) throw new Error(result.error);

  onStage?.("uploading", 0);
  const attemptId = await transferArtifact(file, result, (sent) =>
    onStage?.("uploading", Math.min(1, sent / file.size))
  );

  onStage?.("verifying");
  await completeArtifact(result.artifactId, attemptId);
  return result.artifactId;
}

/**
 * Re-uploads a pending or failed artifact. The file must be the one that
 * was registered: its size and SHA-256 are checked locally before anything
 * is sent (the backend checks again).
 */
export async function retryArtifactUpload(
  artifact: Pick<Artifact, "artifactId" | "attemptId" | "sizeBytes" | "sha256">,
  file: File,
  onStage?: (stage: SingleUploadStage | "checking", progress?: number) => void
): Promise<void> {
  onStage?.("checking");
  if (file.size !== artifact.sizeBytes) {
    throw new Error("Selected file does not match the original upload (size mismatch)");
  }
  onStage?.("hashing", 0);
  const sha256 = await sha256File(file, (done) => onStage?.("hashing", done / file.size));
  if (sha256 !== artifact.sha256) {
    throw new Error("Selected file does not match the original upload (checksum mismatch)");
  }

  onStage?.("reserving");
  const presigned = await retryArtifact(artifact.artifactId, artifact.attemptId);

  onStage?.("uploading", 0);
  const attemptId = await transferArtifact(file, presigned, (sent) =>
    onStage?.("uploading", Math.min(1, sent / file.size))
  );

  onStage?.("verifying");
  await completeArtifact(artifact.artifactId, attemptId);
}
