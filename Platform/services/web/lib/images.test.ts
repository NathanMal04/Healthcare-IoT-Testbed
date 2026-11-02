import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/api pulls in Amplify; the image logic only needs apiRequest (mocked)
// and ApiError, so the module is replaced with a stand-in of the same shape.
vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    readonly status: number;
    readonly details: Record<string, unknown>;
    constructor(message: string, status: number, details: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  return { ApiError, apiRequest: vi.fn() };
});

import { ApiError, apiRequest } from "@/lib/api";
import { ARTIFACT_TYPES, ARTIFACT_TYPE_LABELS } from "@/lib/artifacts";
import {
  GALLERY_PAGE_SIZE,
  ImageUrlCache,
  MAX_IMAGE_SIZE_BYTES,
  appendImages,
  applyImageUpdate,
  capturedAtError,
  capturedAtHasTime,
  capturedAtToInput,
  checkImageFile,
  detectImageMimeType,
  fileIdentity,
  formatCapturedAt,
  getImageViewUrls,
  imageDescriptionError,
  imageErrorMessage,
  imageFormError,
  imageTitle,
  imageTitleError,
  imageToForm,
  imageUpdateBody,
  isImageArtifact,
  lightboxStep,
  listDeviceImages,
  replaceImage,
  updateImageMetadata,
  type ImageArtifact,
  type ViewUrlResult,
} from "@/lib/images";

const request = vi.mocked(apiRequest);
const DEVICE = "11111111-1111-4111-8111-111111111111";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = new Uint8Array([...Array.from(new TextEncoder().encode("RIFF")), 36, 0, 0, 0, ...Array.from(new TextEncoder().encode("WEBPVP8 "))]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");

function file(bytes: Uint8Array, name: string, type = ""): File {
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { type });
}

function image(overrides: Partial<ImageArtifact> = {}): ImageArtifact {
  return {
    artifactId: "0192b000-0000-7000-8000-000000000001",
    name: "board.png",
    type: "image",
    origin: "upload",
    version: null,
    status: "ready",
    statusReason: null,
    sizeBytes: 1000,
    sha256: "a".repeat(64),
    originalFilename: "board.png",
    tags: [],
    deviceIds: [DEVICE],
    uploadBatchId: "batch-1",
    uploadMode: "single",
    attemptId: "attempt-1",
    createdAt: "2026-10-01T10:00:00+00:00",
    uploadedAt: "2026-10-01T10:00:05+00:00",
    statusUpdatedAt: null,
    title: "Main board",
    description: null,
    mimeType: "image/png",
    capturedAt: null,
    updatedAt: "2026-10-01T10:00:05+00:00",
    ...overrides,
  };
}

beforeEach(() => {
  request.mockReset();
});

// --- API helpers ---------------------------------------------------------------

describe("image API helpers", () => {
  it("lists a device's images through the device artifact listing, one page at a time", async () => {
    request.mockResolvedValueOnce({ artifacts: [image()], nextToken: "page-2" });
    const page = await listDeviceImages(DEVICE);
    expect(request).toHaveBeenCalledWith("GET", `/devices/${DEVICE}/artifacts`, {
      query: { type: "image", limit: GALLERY_PAGE_SIZE, nextToken: undefined },
    });
    expect(page).toEqual({ images: [image()], nextToken: "page-2" });

    request.mockResolvedValueOnce({ artifacts: [] });
    expect(await listDeviceImages(DEVICE, { nextToken: "page-2" })).toEqual({ images: [], nextToken: undefined });
    expect(request.mock.calls[1][2]).toEqual({ query: { type: "image", limit: GALLERY_PAGE_SIZE, nextToken: "page-2" } });
  });

  it("keeps only image artifacts from a listing", async () => {
    request.mockResolvedValueOnce({ artifacts: [image(), { ...image(), artifactId: "x", type: "firmware" }] });
    expect((await listDeviceImages(DEVICE)).images.map((i) => i.artifactId)).toEqual([image().artifactId]);
    expect(isImageArtifact({ ...image(), type: "pcap" })).toBe(false);
  });

  it("asks for view URLs in batches of at most 100 distinct ids", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    request.mockImplementation(async (_method, _path, options) => ({
      results: (options!.body as { artifactIds: string[] }).artifactIds.map((artifactId) => ({
        artifactId, ok: true, url: `https://s3/${artifactId}`, mimeType: "image/png", expiresIn: 300,
      })),
    }));
    const results = await getImageViewUrls([...ids, "id-0", "id-1"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
      ["POST", "/artifacts/view-urls"],
      ["POST", "/artifacts/view-urls"],
    ]);
    expect(request.mock.calls.map(([, , o]) => (o!.body as { artifactIds: string[] }).artifactIds.length)).toEqual([100, 50]);
    expect(results.map((r) => r.artifactId)).toEqual(ids);
  });

  it("sends only metadata in a PATCH and applies the response without changing identity or file", async () => {
    const saved = {
      artifactId: image().artifactId, type: "image", status: "ready", title: "New", description: null,
      mimeType: "image/png", capturedAt: "2025-05-01", updatedAt: "2026-10-31T00:00:00+00:00",
    } as const;
    request.mockResolvedValueOnce(saved);
    const response = await updateImageMetadata(image().artifactId, { title: "New", capturedAt: "2025-05-01" });
    expect(request).toHaveBeenCalledWith("PATCH", `/artifacts/${image().artifactId}`, {
      body: { title: "New", capturedAt: "2025-05-01" },
    });
    const applied = applyImageUpdate(image({ description: "old" }), response);
    expect(applied).toEqual({ ...image(), title: "New", description: null, capturedAt: "2025-05-01", updatedAt: saved.updatedAt });
    expect(applied.mimeType).toBe("image/png");
    expect(applied.sha256).toBe(image().sha256);
  });
});

// --- Upload validation ------------------------------------------------------------

describe("image file checks", () => {
  it("detects JPEG, PNG and WebP from their bytes, whatever the name or browser type", async () => {
    expect(await detectImageMimeType(file(PNG, "photo.jpg", "image/jpeg"))).toBe("image/png");
    expect(await detectImageMimeType(file(JPEG, "scan.png"))).toBe("image/jpeg");
    expect(await detectImageMimeType(file(WEBP, "x.bin"))).toBe("image/webp");
  });

  it("refuses SVG, GIF, HTML, truncated and other files before upload", async () => {
    for (const [bytes, name] of [
      [SVG, "logo.svg"],
      [SVG, "renamed.png"],
      [GIF, "anim.gif"],
      [new TextEncoder().encode("<html></html>"), "page.jpg"],
      [PNG.slice(0, 5), "short.png"],
      [new TextEncoder().encode("RIFF\0\0\0\0WAVE"), "sound.webp"],
    ] as const) {
      expect(await checkImageFile(file(bytes, name, "image/png"))).toEqual({ ok: false, reason: "not a JPEG, PNG or WebP image" });
    }
  });

  it("refuses empty files and files over 25 MiB", async () => {
    expect(await checkImageFile(file(new Uint8Array(), "empty.png"))).toEqual({ ok: false, reason: "empty" });
    const big = new Uint8Array(MAX_IMAGE_SIZE_BYTES + 1);
    big.set(PNG);
    expect(await checkImageFile(file(big, "huge.png"))).toEqual({ ok: false, reason: "over 25 MiB" });
    const limit = new Uint8Array(MAX_IMAGE_SIZE_BYTES);
    limit.set(PNG);
    expect(await checkImageFile(file(limit, "max.png"))).toEqual({ ok: true, mimeType: "image/png" });
  });

  it("identifies the same chosen file twice, so it isn't queued twice", () => {
    const a = new File([PNG], "a.png", { lastModified: 1 });
    expect(fileIdentity(a, "a.png")).toBe(fileIdentity(new File([PNG], "a.png", { lastModified: 1 }), "a.png"));
    expect(fileIdentity(a, "a.png")).not.toBe(fileIdentity(a, "folder/a.png"));
  });
});

describe("image field validation (same rules as the backend)", () => {
  const now = new Date(2026, 9, 31, 12);

  it("validates titles", () => {
    expect(imageTitleError("")).toBeNull();
    expect(imageTitleError("  ", { required: true })).toBe("Title can't be empty");
    expect(imageTitleError("x".repeat(200))).toBeNull();
    expect(imageTitleError("x".repeat(201))).toMatch(/at most 200/);
    // Counted in code points, like Python: 200 emoji are fine.
    expect(imageTitleError("📷".repeat(200))).toBeNull();
    expect(imageTitleError("bad\u0007title")).toMatch(/invalid characters/);
    expect(imageTitleError("line\nbreak")).toMatch(/invalid characters/);
  });

  it("validates descriptions, allowing line breaks and tabs", () => {
    expect(imageDescriptionError("")).toBeNull();
    expect(imageDescriptionError("Top side\n\tUART pads")).toBeNull();
    expect(imageDescriptionError("x".repeat(2001))).toMatch(/at most 2000/);
    expect(imageDescriptionError("nul\u0000")).toMatch(/invalid characters/);
  });

  it("validates capture dates: optional, real calendar days, 1970 to today", () => {
    expect(capturedAtError("", now)).toBeNull();
    expect(capturedAtError("2019-03-04", now)).toBeNull();
    expect(capturedAtError("2026-10-31", now)).toBeNull();
    expect(capturedAtError("2026-11-01", now)).toMatch(/future/);
    expect(capturedAtError("1969-12-31", now)).toMatch(/before 1970/);
    expect(capturedAtError("2023-02-30", now)).toMatch(/valid date/);
    expect(capturedAtError("03/04/2019", now)).toMatch(/YYYY-MM-DD/);
  });

  it("doesn't re-validate an unchanged capture date when other fields are edited", () => {
    // The backend accepts up to a day ahead (time-zone slack); such a stored
    // value must not block saving a new title.
    const stored = image({ capturedAt: "2026-11-01" });
    const form = { ...imageToForm(stored), title: "New title" };
    expect(imageFormError(form, now, stored)).toBeNull();
    expect(imageUpdateBody(stored, form)).toEqual({ title: "New title" });
    // A changed date is still checked.
    expect(imageFormError({ ...form, capturedAt: "2026-11-02" }, now, stored)).toMatch(/future/);
    // Without the image (e.g. a new form) every value is checked.
    expect(imageFormError(form, now)).toMatch(/future/);
    // A stored UTC date-time keeps its meaning: unchanged, it's neither checked nor sent.
    const precise = image({ capturedAt: "2026-11-01T02:00:00+00:00" });
    const preciseForm = { ...imageToForm(precise), description: "x" };
    expect(imageFormError(preciseForm, now, precise)).toBeNull();
    expect(imageUpdateBody(precise, preciseForm)).toEqual({ description: "x" });
    expect(capturedAtHasTime(precise.capturedAt)).toBe(true);
    expect(capturedAtHasTime("2026-11-01")).toBe(false);
    expect(capturedAtHasTime(null)).toBe(false);
  });

  it("checks the whole edit form", () => {
    expect(imageFormError({ title: "Board", description: "", capturedAt: "" }, now)).toBeNull();
    expect(imageFormError({ title: "", description: "", capturedAt: "" }, now)).toBe("Title can't be empty");
    expect(imageFormError({ title: "Board", description: "", capturedAt: "2030-01-01" }, now)).toMatch(/future/);
  });
});

// --- Display -------------------------------------------------------------------------

describe("capture date display", () => {
  it("shows a date-only capture date as that calendar day in every time zone", () => {
    expect(formatCapturedAt("2024-01-05")).toBe(
      new Date(2024, 0, 5).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    );
  });

  it("shows a date-time in local time, and nothing for missing or bad values", () => {
    expect(formatCapturedAt("2024-01-05T10:30:00+00:00")).toContain("2024");
    expect(formatCapturedAt(null)).toBeNull();
    expect(formatCapturedAt("not a date")).toBeNull();
  });

  it("puts a stored value into a date input", () => {
    expect(capturedAtToInput("2024-01-05")).toBe("2024-01-05");
    const instant = "2024-01-05T10:30:00+00:00";
    const local = new Date(instant);
    const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
    expect(capturedAtToInput(instant)).toBe(expected);
    expect(capturedAtToInput(null)).toBe("");
  });

  it("falls back to the name when an image has no title", () => {
    expect(imageTitle(image({ title: "" }))).toBe("board.png");
    expect(imageTitle(image())).toBe("Main board");
  });
});

// --- Metadata editing ------------------------------------------------------------------

describe("image metadata edits", () => {
  it("sends nothing when nothing changed", () => {
    const original = image({ description: "Top side", capturedAt: "2025-01-02" });
    expect(imageUpdateBody(original, imageToForm(original))).toEqual({});
    // Whitespace-only changes don't count.
    expect(imageUpdateBody(original, { ...imageToForm(original), title: "  Main board " })).toEqual({});
  });

  it("sends only changed fields, trimmed", () => {
    const original = image({ description: "Top side", capturedAt: "2025-01-02" });
    expect(imageUpdateBody(original, { ...imageToForm(original), title: " UART header " })).toEqual({ title: "UART header" });
    expect(imageUpdateBody(original, { ...imageToForm(original), capturedAt: "2024-12-31" })).toEqual({ capturedAt: "2024-12-31" });
  });

  it("clears optional fields with null", () => {
    const original = image({ description: "Top side", capturedAt: "2025-01-02" });
    expect(imageUpdateBody(original, { title: "Main board", description: "  ", capturedAt: "" })).toEqual({
      description: null,
      capturedAt: null,
    });
  });

  it("never rewrites an unchanged precise capture time", () => {
    const original = image({ capturedAt: "2025-01-02T08:15:00+00:00" });
    const form = imageToForm(original);
    expect(imageUpdateBody(original, { ...form, description: "New" })).toEqual({ description: "New" });
  });

  it("can't change the format or identity: only title, description and capturedAt are ever sent", () => {
    const body = imageUpdateBody(image(), { title: "x", description: "y", capturedAt: "2020-01-01" });
    expect(Object.keys(body).sort()).toEqual(["capturedAt", "description", "title"]);
  });
});

// --- Pagination and the viewer ------------------------------------------------------------

describe("gallery pages and viewer navigation", () => {
  const a = image({ artifactId: "a" });
  const b = image({ artifactId: "b" });
  const c = image({ artifactId: "c" });

  it("appends pages without duplicating images", () => {
    expect(appendImages([a, b], [b, c]).map((i) => i.artifactId)).toEqual(["a", "b", "c"]);
  });

  it("replaces an edited image in place", () => {
    const edited = { ...b, title: "Edited" };
    expect(replaceImage([a, b, c], edited)).toEqual([a, edited, c]);
  });

  it("moves within the loaded images and asks for the next page at the end", () => {
    expect(lightboxStep(0, -1, 3, true)).toEqual({ kind: "none" });
    expect(lightboxStep(0, 1, 3, false)).toEqual({ kind: "show", index: 1 });
    expect(lightboxStep(2, -1, 3, false)).toEqual({ kind: "show", index: 1 });
    expect(lightboxStep(2, 1, 3, true)).toEqual({ kind: "load-more" });
    expect(lightboxStep(2, 1, 3, false)).toEqual({ kind: "none" });
  });
});

// --- Errors -----------------------------------------------------------------------------

describe("image error messages", () => {
  it("explains expired sessions, missing access and missing images", () => {
    expect(imageErrorMessage(new ApiError("Unauthorized", 401), "x")).toMatch(/session has expired/);
    expect(imageErrorMessage(new Error("No Cognito ID token available"), "x")).toMatch(/session has expired/);
    expect(imageErrorMessage(new ApiError("Forbidden", 403), "x")).toMatch(/don't have access/);
    expect(imageErrorMessage(new ApiError("Artifact not found", 404), "x")).toMatch(/no longer exists/);
    expect(imageErrorMessage(new ApiError("title must be a non-empty string", 400), "x")).toBe("title must be a non-empty string");
    expect(imageErrorMessage("weird", "Fallback")).toBe("Fallback");
  });
});

// --- View URLs: caching, expiry and refresh ----------------------------------------------

function ok(artifactId: string, url = `https://s3/${artifactId}?sig=1`, expiresIn = 300): ViewUrlResult {
  return { artifactId, ok: true, url, mimeType: "image/png", expiresIn };
}

describe("ImageUrlCache", () => {
  let now = 1_000_000;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it("fetches missing ids in one batch and serves them from memory", async () => {
    const fetchUrls = vi.fn(async (ids: string[]) => ids.map((id) => ok(id)));
    const cache = new ImageUrlCache(fetchUrls, clock);
    expect(cache.get("a")).toBeUndefined();
    await cache.ensure(["a", "b", "a"]);
    expect(fetchUrls).toHaveBeenCalledWith(["a", "b"]);
    expect(cache.get("a")).toEqual({ status: "ready", url: "https://s3/a?sig=1", expiresAt: now + 300_000, stale: false });
    await cache.ensure(["a", "b"]);
    expect(fetchUrls).toHaveBeenCalledTimes(1);
  });

  it("joins every request made in the same tick into one batch", async () => {
    const fetchUrls = vi.fn(async (ids: string[]) => ids.map((id) => ok(id)));
    const cache = new ImageUrlCache(fetchUrls, clock);
    const ids = Array.from({ length: 24 }, (_, i) => `id-${i}`);
    // As a page of cards does: each asks for its own image, then the gallery for all.
    const waits = ids.map((id) => cache.ensure([id]));
    waits.push(cache.ensure(ids));
    expect(cache.get("id-0")).toEqual({ status: "loading" });
    await Promise.all(waits);
    expect(fetchUrls).toHaveBeenCalledTimes(1);
    expect(fetchUrls).toHaveBeenCalledWith(ids);
    // A later tick is a new batch.
    await cache.ensure(["id-24", "id-25"]);
    expect(fetchUrls).toHaveBeenCalledTimes(2);
    expect(fetchUrls).toHaveBeenLastCalledWith(["id-24", "id-25"]);
  });

  it("asks again for unavailable images once they are forgotten", async () => {
    const fetchUrls = vi
      .fn<(ids: string[]) => Promise<ViewUrlResult[]>>()
      .mockResolvedValueOnce([ok("a"), { artifactId: "b", ok: false, status: 404, error: "Image not found" }])
      .mockImplementation(async (ids) => ids.map((id) => ok(id)));
    const cache = new ImageUrlCache(fetchUrls, clock);
    await cache.ensure(["a", "b"]);
    expect(cache.unavailableCount()).toBe(1);
    cache.forgetUnavailable();
    expect(cache.unavailableCount()).toBe(0);
    await cache.ensure(["a", "b"]);
    expect(fetchUrls).toHaveBeenLastCalledWith(["b"]);
    expect(cache.get("b")).toMatchObject({ status: "ready" });
  });

  it("shares one request between concurrent callers", async () => {
    let resolve!: (r: ViewUrlResult[]) => void;
    const fetchUrls = vi.fn(() => new Promise<ViewUrlResult[]>((r) => (resolve = r)));
    const cache = new ImageUrlCache(fetchUrls, clock);
    const first = cache.ensure(["a"]);
    const second = cache.ensure(["a"]);
    expect(cache.get("a")).toEqual({ status: "loading" });
    // The batch is sent on the next microtask.
    await vi.waitFor(() => expect(fetchUrls).toHaveBeenCalled());
    resolve([ok("a")]);
    await Promise.all([first, second]);
    expect(fetchUrls).toHaveBeenCalledTimes(1);
  });

  it("marks a URL stale before it expires and fetches a new one when next needed", async () => {
    let n = 0;
    const fetchUrls = vi.fn(async (ids: string[]) => ids.map((id) => ok(id, `https://s3/${id}?sig=${++n}`)));
    const cache = new ImageUrlCache(fetchUrls, clock, 30_000);
    await cache.ensure(["a"]);
    now += 269_000;
    expect(cache.url("a")).toBe("https://s3/a?sig=1");
    now += 2_000; // within 30 s of expiry
    expect(cache.get("a")).toMatchObject({ status: "ready", stale: true });
    expect(cache.url("a")).toBeUndefined();
    await cache.ensure(["a"]);
    expect(fetchUrls).toHaveBeenCalledTimes(2);
    expect(cache.get("a")).toMatchObject({ url: "https://s3/a?sig=2", stale: false });
  });

  it("fetches again after a failed image load invalidates the entry", async () => {
    const fetchUrls = vi.fn(async (ids: string[]) => ids.map((id) => ok(id)));
    const cache = new ImageUrlCache(fetchUrls, clock);
    await cache.ensure(["a"]);
    now += 60_000;
    expect(cache.ageOf("a")).toBe(60_000);
    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    await cache.ensure(["a"]);
    expect(fetchUrls).toHaveBeenCalledTimes(2);
    expect(cache.ageOf("a")).toBe(0);
  });

  it("records missing, unauthorized and non-ready images as unavailable without refetching them", async () => {
    const fetchUrls = vi.fn(async (): Promise<ViewUrlResult[]> => [
      ok("a"),
      { artifactId: "gone", ok: false, status: 404, error: "Image not found" },
    ]);
    const cache = new ImageUrlCache(fetchUrls, clock);
    await cache.ensure(["a", "gone", "unanswered"]);
    expect(cache.get("gone")).toEqual({ status: "unavailable", error: "Image unavailable" });
    expect(cache.get("unanswered")).toEqual({ status: "unavailable", error: "Image unavailable" });
    await cache.ensure(["gone", "unanswered"]);
    expect(fetchUrls).toHaveBeenCalledTimes(1);
  });

  it("drops entries when the whole request fails (e.g. expired session), so a retry fetches them", async () => {
    const fetchUrls = vi
      .fn<(ids: string[]) => Promise<ViewUrlResult[]>>()
      .mockRejectedValueOnce(new ApiError("Unauthorized", 401))
      .mockImplementation(async (ids) => ids.map((id) => ok(id)));
    const cache = new ImageUrlCache(fetchUrls, clock);
    await expect(cache.ensure(["a"])).rejects.toThrow("Unauthorized");
    expect(cache.get("a")).toBeUndefined();
    await cache.ensure(["a"]);
    expect(cache.get("a")).toMatchObject({ status: "ready" });
  });

  it("notifies subscribers and keeps URLs only in memory", async () => {
    const cache = new ImageUrlCache(async (ids) => ids.map((id) => ok(id)), clock);
    const listener = vi.fn();
    const unsubscribe = cache.subscribe(listener);
    await cache.ensure(["a"]);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
  });
});

// --- Artifact types: images don't leak into the generic lists ------------------------------

describe("artifact types", () => {
  it("labels images but keeps them out of the generic category, uploader and run type lists", () => {
    expect(ARTIFACT_TYPE_LABELS.image).toEqual({ category: "Images", single: "Image" });
    expect(ARTIFACT_TYPES).not.toContain("image");
  });
});
