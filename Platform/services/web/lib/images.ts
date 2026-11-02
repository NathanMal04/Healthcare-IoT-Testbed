import { ApiError, apiRequest } from "@/lib/api";
import { listDeviceArtifacts, type Artifact, type ArtifactPage } from "@/lib/artifacts";

// Device images: photographs from teardowns and reverse engineering. On the
// backend an image is an ordinary artifact with type "image" (same upload
// pipeline, scope and device links) plus title, description, mimeType and
// capturedAt. Everything here is plain logic or a thin API call, so the
// gallery, the lightbox and (later) a notebook image picker share it.
//
// An image is referenced by its artifactId only. A view URL is short-lived
// (POST /artifacts/view-urls) and is never stored anywhere but the in-memory
// ImageUrlCache below.

// --- Constants (mirroring _shared/python/image_fields.py) --------------------

export const IMAGE_TYPE = "image" as const;
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
export const MAX_IMAGE_SIZE_BYTES = 25 * 1024 ** 2; // 25 MiB
export const MAX_IMAGE_TITLE_LENGTH = 200;
export const MAX_IMAGE_DESCRIPTION_LENGTH = 2000;
/** For <input type="file" accept>; the file's bytes are still checked. */
export const IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";
/** POST /artifacts/view-urls takes at most this many ids per request. */
export const MAX_VIEW_URL_IDS = 100;
/** Images per gallery page (GET /devices/{id}/artifacts?type=image). */
// Small, because the grid shows the original files: there are no thumbnails
// yet, so each card downloads and decodes a full photograph (up to 25 MiB).
export const GALLERY_PAGE_SIZE = 12;

const EARLIEST_CAPTURE = "1970-01-01";
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// Control characters (Unicode category Cc), as the backend refuses them.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARS_EXCEPT_NEWLINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

// --- Types --------------------------------------------------------------------

/** An image artifact as the listing and detail endpoints return it. */
export interface ImageArtifact extends Artifact {
  type: typeof IMAGE_TYPE;
  title: string;
  description: string | null;
  mimeType: ImageMimeType;
  /** When the photograph was taken: "YYYY-MM-DD" or a UTC ISO date-time. */
  capturedAt: string | null;
  updatedAt: string | null;
}

/** The image fields sent with a presign request (title defaults to the name). */
export interface ImageUploadFields {
  mimeType: ImageMimeType;
  title?: string;
  description?: string;
  capturedAt?: string;
}

/** PATCH /artifacts/{id} for an image: null clears description or capturedAt. */
export interface ImageMetadataUpdate {
  title?: string;
  description?: string | null;
  capturedAt?: string | null;
}

export interface UpdatedImage {
  artifactId: string;
  type: typeof IMAGE_TYPE;
  status: Artifact["status"];
  title: string;
  description: string | null;
  mimeType: ImageMimeType;
  capturedAt: string | null;
  updatedAt: string | null;
}

export type ViewUrlResult =
  | { artifactId: string; ok: true; url: string; mimeType: ImageMimeType; expiresIn: number }
  | { artifactId: string | null; ok: false; status: number; error: string };

export function isImageArtifact(artifact: Artifact): artifact is ImageArtifact {
  return artifact.type === IMAGE_TYPE;
}

// --- API ----------------------------------------------------------------------

/** One page of a device's images, newest upload first. */
export async function listDeviceImages(
  deviceId: string,
  options: { nextToken?: string; limit?: number } = {}
): Promise<{ images: ImageArtifact[]; nextToken?: string }> {
  const page: ArtifactPage = await listDeviceArtifacts(deviceId, {
    type: IMAGE_TYPE,
    limit: options.limit ?? GALLERY_PAGE_SIZE,
    nextToken: options.nextToken,
  });
  // The backend filters by type; this only keeps the result well-typed.
  return { images: page.artifacts.filter(isImageArtifact), nextToken: page.nextToken };
}

/** Short-lived inline URLs for images, in batches of at most 100 ids. */
export async function getImageViewUrls(artifactIds: string[]): Promise<ViewUrlResult[]> {
  const unique = Array.from(new Set(artifactIds));
  const results: ViewUrlResult[] = [];
  for (let i = 0; i < unique.length; i += MAX_VIEW_URL_IDS) {
    const batch = unique.slice(i, i + MAX_VIEW_URL_IDS);
    const response = await apiRequest<{ results: ViewUrlResult[] }>("POST", "/artifacts/view-urls", {
      body: { artifactIds: batch },
    });
    results.push(...response.results);
  }
  return results;
}

export function updateImageMetadata(artifactId: string, update: ImageMetadataUpdate): Promise<UpdatedImage> {
  return apiRequest("PATCH", `/artifacts/${encodeURIComponent(artifactId)}`, { body: update });
}

/** The image with the fields a PATCH returned; identity and file are unchanged. */
export function applyImageUpdate(image: ImageArtifact, updated: UpdatedImage): ImageArtifact {
  return {
    ...image,
    title: updated.title,
    description: updated.description,
    capturedAt: updated.capturedAt,
    updatedAt: updated.updatedAt,
  };
}

// --- File checks (before anything is uploaded) ---------------------------------

/**
 * The image format from the file's first bytes, or null if it isn't JPEG,
 * PNG or WebP. The same signatures the backend checks when the upload is
 * completed, so a renamed SVG, GIF or HEIC is refused here, before upload.
 */
export async function detectImageMimeType(file: Blob): Promise<ImageMimeType | null> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...Array.from(head.slice(from, to)));
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

export type ImageFileCheck = { ok: true; mimeType: ImageMimeType } | { ok: false; reason: string };

/** Whether a chosen file can be uploaded as an image, and its format. */
export async function checkImageFile(file: Blob): Promise<ImageFileCheck> {
  if (file.size === 0) return { ok: false, reason: "empty" };
  if (file.size > MAX_IMAGE_SIZE_BYTES) return { ok: false, reason: "over 25 MiB" };
  const mimeType = await detectImageMimeType(file);
  if (!mimeType) return { ok: false, reason: "not a JPEG, PNG or WebP image" };
  return { ok: true, mimeType };
}

/** Identifies a chosen file, so the same file isn't queued twice. */
export function fileIdentity(file: File, path: string): string {
  return `${path}\u0000${file.size}\u0000${file.lastModified}`;
}

// --- Field validation (same rules as the backend) ----------------------------

/** Length in code points, as the backend (Python) counts it. */
function codePoints(value: string): number {
  return Array.from(value).length;
}

/** For an optional upload title ("" uses the file name) or a required edited title. */
export function imageTitleError(value: string, { required = false } = {}): string | null {
  const title = value.trim();
  if (!title) return required ? "Title can't be empty" : null;
  if (codePoints(title) > MAX_IMAGE_TITLE_LENGTH) return `Title must be at most ${MAX_IMAGE_TITLE_LENGTH} characters`;
  if (CONTROL_CHARS.test(title)) return "Title contains invalid characters";
  return null;
}

export function imageDescriptionError(value: string): string | null {
  const description = value.trim();
  if (codePoints(description) > MAX_IMAGE_DESCRIPTION_LENGTH) {
    return `Description must be at most ${MAX_IMAGE_DESCRIPTION_LENGTH} characters`;
  }
  if (CONTROL_CHARS_EXCEPT_NEWLINES.test(description)) return "Description contains invalid characters";
  return null;
}

/** Today's date in the viewer's time zone, as "YYYY-MM-DD" (the latest capture date). */
export function todayInput(now: Date = new Date()): string {
  return localDateInput(now);
}

function localDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A capture date from a date input ("" means not set). */
export function capturedAtError(value: string, now: Date = new Date()): string | null {
  if (!value) return null;
  const match = DATE_ONLY.exec(value);
  if (!match) return "Captured date must be a date (YYYY-MM-DD)";
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return "Captured date isn't a valid date";
  }
  if (value < EARLIEST_CAPTURE) return "Captured date can't be before 1970";
  if (value > todayInput(now)) return "Captured date can't be in the future";
  return null;
}

// --- Display ------------------------------------------------------------------

/**
 * A capture date for display. A date-only value is a calendar day, so it is
 * shown as that day in every time zone (new Date("2024-01-05") would be UTC
 * midnight, i.e. Jan 4 in the Americas); a date-time is shown in local time.
 */
export function formatCapturedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = DATE_ONLY.exec(value);
  const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return match
    ? date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The value a date input shows for a stored capturedAt (a date-time's local day). */
export function capturedAtToInput(value: string | null | undefined): string {
  if (!value) return "";
  if (DATE_ONLY.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : localDateInput(date);
}

/** The title to show: the image's title, else its name. */
export function imageTitle(image: Pick<ImageArtifact, "title" | "name">): string {
  return image.title || image.name;
}

// --- Editing ------------------------------------------------------------------

export interface ImageForm {
  title: string;
  description: string;
  capturedAt: string;
}

export function imageToForm(image: ImageArtifact): ImageForm {
  return {
    title: imageTitle(image),
    description: image.description ?? "",
    capturedAt: capturedAtToInput(image.capturedAt),
  };
}

/**
 * The first problem with an edit form, or null. With the image being edited,
 * the capture date is only checked when it was changed: a stored value the
 * backend accepted (it allows a day of time-zone slack) never blocks saving
 * the other fields, and isn't sent either (imageUpdateBody).
 */
export function imageFormError(form: ImageForm, now: Date = new Date(), image?: ImageArtifact): string | null {
  const dateChanged = !image || form.capturedAt !== capturedAtToInput(image.capturedAt);
  return (
    imageTitleError(form.title, { required: true }) ??
    imageDescriptionError(form.description) ??
    (dateChanged ? capturedAtError(form.capturedAt, now) : null)
  );
}

/** True when a stored capture date has a time of day, which choosing a new date replaces. */
export function capturedAtHasTime(value: string | null | undefined): boolean {
  return !!value && !DATE_ONLY.test(value);
}

/**
 * Only the fields that changed. A cleared description or capture date is
 * sent as null, which removes it. An unchanged capture date is never sent,
 * so a precise stored date-time isn't reduced to its day by opening the form.
 */
export function imageUpdateBody(image: ImageArtifact, form: ImageForm): ImageMetadataUpdate {
  const original = imageToForm(image);
  const update: ImageMetadataUpdate = {};
  const title = form.title.trim();
  if (title !== original.title.trim()) update.title = title;
  const description = form.description.trim();
  if (description !== original.description.trim()) update.description = description || null;
  if (form.capturedAt !== original.capturedAt) update.capturedAt = form.capturedAt || null;
  return update;
}

// --- Gallery state ------------------------------------------------------------

/** Appends a page, skipping images already shown (e.g. after an upload shifted the pages). */
export function appendImages(current: ImageArtifact[], page: ImageArtifact[]): ImageArtifact[] {
  const seen = new Set(current.map((image) => image.artifactId));
  return [...current, ...page.filter((image) => !seen.has(image.artifactId))];
}

export function replaceImage(images: ImageArtifact[], updated: ImageArtifact): ImageArtifact[] {
  return images.map((image) => (image.artifactId === updated.artifactId ? updated : image));
}

export type LightboxStep = { kind: "show"; index: number } | { kind: "load-more" } | { kind: "none" };

/**
 * Where previous/next goes from `index` among the images loaded so far.
 * Past the last loaded image, while more pages exist, the next page has to
 * be loaded first; the viewer never assumes every image is loaded.
 */
export function lightboxStep(index: number, delta: -1 | 1, loadedCount: number, hasMore: boolean): LightboxStep {
  const next = index + delta;
  if (next < 0) return { kind: "none" };
  if (next < loadedCount) return { kind: "show", index: next };
  return hasMore ? { kind: "load-more" } : { kind: "none" };
}

// --- Errors -------------------------------------------------------------------

/** A message for a failed image request: expired session, no access, gone, or the error itself. */
export function imageErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Your session has expired. Sign in again to continue.";
    if (err.status === 403) return "You don't have access to this device's images in the current scope.";
    if (err.status === 404) return "This image no longer exists, or you no longer have access to it.";
    return err.message || fallback;
  }
  if (err instanceof Error) {
    // lib/api's getIdToken when Amplify has no valid session any more.
    if (err.message === "No Cognito ID token available") return "Your session has expired. Sign in again to continue.";
    return err.message || fallback;
  }
  return fallback;
}

// --- View URL cache -----------------------------------------------------------

export type ImageUrlState =
  | { status: "loading" }
  /** `stale`: expired or about to; fine for an image already shown, else call ensure(). */
  | { status: "ready"; url: string; expiresAt: number; stale: boolean }
  | { status: "unavailable"; error: string };

type Entry =
  | { status: "loading"; fetchedAt?: number }
  | { status: "ready"; url: string; expiresAt: number; fetchedAt: number }
  | { status: "unavailable"; error: string; fetchedAt?: number };

/**
 * Short-lived view URLs, kept in memory only. Every ensure() made in the
 * same tick joins one batch, so a page of cards that each ask for their own
 * image costs one POST /artifacts/view-urls (split into 100s by
 * getImageViewUrls), and a request for an id already in flight shares that
 * fetch. An entry close to
 * expiry is fetched again when it is next needed, and `invalidate` drops an
 * entry whose image failed to load (e.g. the URL expired while the image
 * was waiting to load lazily) so it is fetched once more.
 */
export class ImageUrlCache {
  private entries = new Map<string, Entry>();
  private inFlight = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  // Ids waiting for this tick's batch, and the promise of that batch.
  private queued: string[] = [];
  private batch?: Promise<void>;

  constructor(
    private readonly fetchUrls: (ids: string[]) => Promise<ViewUrlResult[]> = getImageViewUrls,
    private readonly now: () => number = Date.now,
    /** An entry this close to expiry counts as expired. */
    private readonly refreshMarginMs = 30_000
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(artifactId: string): ImageUrlState | undefined {
    const entry = this.entries.get(artifactId);
    if (!entry) return undefined;
    if (entry.status === "ready") {
      return { status: "ready", url: entry.url, expiresAt: entry.expiresAt, stale: this.isStale(entry) };
    }
    if (entry.status === "loading") return { status: "loading" };
    return { status: "unavailable", error: entry.error };
  }

  /** The URL if it is still usable, without fetching. */
  url(artifactId: string): string | undefined {
    const entry = this.entries.get(artifactId);
    return entry?.status === "ready" && !this.isStale(entry) ? entry.url : undefined;
  }

  /** Fetches URLs for the ids that have none, or one about to expire. */
  async ensure(artifactIds: string[]): Promise<void> {
    const waits: Promise<void>[] = [];
    const missing: string[] = [];
    for (const id of new Set(artifactIds)) {
      const pending = this.inFlight.get(id);
      if (pending) {
        waits.push(pending);
        continue;
      }
      const entry = this.entries.get(id);
      if (entry?.status === "unavailable") continue;
      if (entry?.status === "ready" && !this.isStale(entry)) continue;
      missing.push(id);
    }
    if (missing.length) waits.push(this.enqueue(missing));
    await Promise.all(waits);
  }

  /** Forgets entries the server reported as unavailable, so the next ensure() asks again. */
  forgetUnavailable() {
    let changed = false;
    this.entries.forEach((entry, id) => {
      if (entry.status === "unavailable") changed = this.entries.delete(id) || changed;
    });
    if (changed) this.emit();
  }

  /** How many entries the server reported as unavailable. */
  unavailableCount(): number {
    let count = 0;
    this.entries.forEach((entry) => {
      if (entry.status === "unavailable") count++;
    });
    return count;
  }

  private enqueue(ids: string[]): Promise<void> {
    for (const id of ids) {
      // A stale URL stays readable (for an image already shown) until replaced.
      if (!this.entries.has(id)) this.entries.set(id, { status: "loading" });
      this.queued.push(id);
    }
    if (!this.batch) {
      this.batch = Promise.resolve().then(() => {
        const batch = this.queued;
        this.queued = [];
        this.batch = undefined;
        return this.fetch(batch);
      });
    }
    for (const id of ids) this.inFlight.set(id, this.batch);
    this.emit();
    return this.batch;
  }

  /** Forgets an entry so the next ensure() fetches a new URL. */
  invalidate(artifactId: string) {
    if (this.entries.delete(artifactId)) this.emit();
  }

  /** Milliseconds since the entry's URL was fetched (to tell a stale URL from a broken image). */
  ageOf(artifactId: string): number | undefined {
    const fetchedAt = this.entries.get(artifactId)?.fetchedAt;
    return fetchedAt === undefined ? undefined : this.now() - fetchedAt;
  }

  clear() {
    this.entries.clear();
    this.emit();
  }

  private isStale(entry: { expiresAt: number }): boolean {
    return entry.expiresAt - this.refreshMarginMs <= this.now();
  }

  private fetch(ids: string[]): Promise<void> {
    const run = (async () => {
      try {
        const results = await this.fetchUrls(ids);
        const fetchedAt = this.now();
        const answered = new Set<string>();
        for (const result of results) {
          if (!result.artifactId) continue;
          answered.add(result.artifactId);
          this.entries.set(
            result.artifactId,
            result.ok
              ? { status: "ready", url: result.url, expiresAt: fetchedAt + result.expiresIn * 1000, fetchedAt }
              : { status: "unavailable", error: result.status === 404 ? "Image unavailable" : result.error, fetchedAt }
          );
        }
        for (const id of ids) {
          if (!answered.has(id)) this.entries.set(id, { status: "unavailable", error: "Image unavailable", fetchedAt });
        }
      } catch (err) {
        // The whole request failed (network, expired session...): the entries
        // are dropped, not marked unavailable, so a later ensure() tries again.
        for (const id of ids) this.entries.delete(id);
        throw err;
      } finally {
        for (const id of ids) this.inFlight.delete(id);
        this.emit();
      }
    })();
    for (const id of ids) this.inFlight.set(id, run);
    return run;
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}
