// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// lib/api pulls in Amplify: apiRequest is mocked per test, ApiError kept in shape.
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
// The scope context needs its provider; the gallery only reads the lock.
vi.mock("@/context/WorkspaceContext", () => ({
  useWorkspace: () => ({ scopeLocked: false }),
  useScopeLock: () => undefined,
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: null, loading: false }) }));
// Hashing (wasm) and the S3 transfer (XHR) of a replacement are stubbed.
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  sha256File: vi.fn(async () => "b".repeat(64)),
  sendSingleUpload: vi.fn(async () => undefined),
}));

import { ApiError, apiRequest } from "@/lib/api";
import type { Device } from "@/lib/devices";
import type { ImageArtifact, ViewUrlResult } from "@/lib/images";
import DeviceImageGallery from "./DeviceImageGallery";

const request = vi.mocked(apiRequest);
const DEVICE = { deviceId: "11111111-1111-4111-8111-111111111111", name: "Infusion pump", role: "owner" } as Device;

function image(n: number): ImageArtifact {
  const id = `img-${String(n).padStart(2, "0")}`;
  return {
    artifactId: id, name: `${id}.png`, type: "image", origin: "upload", version: null, status: "ready",
    statusReason: null, sizeBytes: 1000, sha256: "a".repeat(64), originalFilename: `${id}.png`, tags: [],
    deviceIds: [DEVICE.deviceId], uploadBatchId: "b", uploadMode: "single", attemptId: "t",
    createdAt: "2026-10-01T10:00:00+00:00", uploadedAt: null, statusUpdatedAt: null,
    title: `Photo ${n}`, description: null, mimeType: "image/png", capturedAt: null, updatedAt: null,
  };
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => image(from + i));

interface Api {
  pages: Record<string, { artifacts: ImageArtifact[]; nextToken?: string } | Error>;
  viewUrls: (ids: string[], call: number) => ViewUrlResult[];
}

/** Routes the gallery's API calls: listing pages by nextToken, and view URLs. */
function serve(api: Api) {
  let viewCalls = 0;
  request.mockImplementation(async (method: string, path: string, options?: { body?: unknown; query?: Record<string, unknown> }) => {
    if (method === "GET" && path === `/devices/${DEVICE.deviceId}/artifacts`) {
      const page = api.pages[String(options?.query?.nextToken ?? "first")];
      if (page instanceof Error) throw page;
      return page;
    }
    if (method === "POST" && path === "/artifacts/view-urls") {
      return { results: api.viewUrls((options!.body as { artifactIds: string[] }).artifactIds, ++viewCalls) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
}

const okUrls = (ids: string[]): ViewUrlResult[] =>
  ids.map((artifactId) => ({ artifactId, ok: true, url: `https://s3.example/${artifactId}?sig`, mimeType: "image/png", expiresIn: 300 }));

/** The artifactIds of every POST /artifacts/view-urls, in order. */
function viewUrlRequests(): string[][] {
  return request.mock.calls
    .filter(([method, path]) => method === "POST" && path === "/artifacts/view-urls")
    .map(([, , options]) => (options!.body as { artifactIds: string[] }).artifactIds);
}

beforeEach(() => {
  request.mockReset();
});
afterEach(cleanup);

describe("DeviceImageGallery", () => {
  it("asks for a page's view URLs in one request, and only for new images on Load more", async () => {
    serve({ pages: { first: { artifacts: range(1, 12), nextToken: "p2" }, p2: { artifacts: range(13, 15) } }, viewUrls: okUrls });
    render(<DeviceImageGallery device={DEVICE} />);

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(12));
    expect(viewUrlRequests()).toEqual([range(1, 12).map((i) => i.artifactId)]);
    expect(screen.getByAltText("Photo 1").getAttribute("src")).toBe("https://s3.example/img-01?sig");
    expect(screen.getByAltText("Photo 1").getAttribute("loading")).toBe("lazy");

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(15));
    expect(viewUrlRequests()).toEqual([range(1, 12).map((i) => i.artifactId), ["img-13", "img-14", "img-15"]]);
    // The listing asked for the next page with the server's token.
    const listings = request.mock.calls.filter(([method]) => method === "GET").map(([, , o]) => o?.query?.nextToken);
    expect(listings).toEqual([undefined, "p2"]);
  });

  it("shows an unavailable image and asks for it again on Try again", async () => {
    serve({
      pages: { first: { artifacts: range(1, 3) } },
      viewUrls: (ids, call) =>
        call === 1
          ? ids.map((artifactId) =>
              artifactId === "img-02"
                ? { artifactId, ok: false, status: 404, error: "Image not found" }
                : okUrls([artifactId])[0]
            )
          : okUrls(ids),
    });
    render(<DeviceImageGallery device={DEVICE} />);

    await waitFor(() => expect(screen.getByText("Image unavailable")).toBeTruthy());
    expect(screen.getByText("1 image couldn't be displayed.")).toBeTruthy();
    expect(screen.queryByAltText("Photo 2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByAltText("Photo 2")).toBeTruthy());
    // Only the unavailable image was asked for again.
    expect(viewUrlRequests()).toEqual([["img-01", "img-02", "img-03"], ["img-02"]]);
    expect(screen.queryByText("1 image couldn't be displayed.")).toBeNull();
  });

  it("keeps independent per-image authorization results", async () => {
    serve({
      pages: { first: { artifacts: range(1, 2) } },
      viewUrls: (ids) =>
        ids.map((artifactId) =>
          artifactId === "img-01" ? okUrls([artifactId])[0] : { artifactId, ok: false, status: 404, error: "Image not found" }
        ),
    });
    render(<DeviceImageGallery device={DEVICE} />);
    await waitFor(() => expect(screen.getByAltText("Photo 1")).toBeTruthy());
    expect(screen.getByText("Image unavailable")).toBeTruthy();
  });

  it("shows a failed view-URL request (e.g. an expired session) and recovers on Try again", async () => {
    let fail = true;
    serve({ pages: { first: { artifacts: range(1, 2) } }, viewUrls: okUrls });
    const routed = request.getMockImplementation()!;
    request.mockImplementation(async (method, path, options) => {
      if (path === "/artifacts/view-urls" && fail) throw new ApiError("Unauthorized", 401);
      return routed(method, path, options);
    });
    render(<DeviceImageGallery device={DEVICE} />);
    await waitFor(() => expect(screen.getByText(/session has expired/)).toBeTruthy());
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
  });

  it("navigates in the viewer and shows a page error inside it", async () => {
    serve({
      pages: { first: { artifacts: range(1, 2), nextToken: "p2" }, p2: new ApiError("Internal error", 500) },
      viewUrls: okUrls,
    });
    render(<DeviceImageGallery device={DEVICE} />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "View Photo 1" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("1 of 2+")).toBeTruthy();

    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() => expect(within(dialog).getByText("2 of 2+")).toBeTruthy());
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    await waitFor(() => expect(within(dialog).getByText("1 of 2+")).toBeTruthy());
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() => expect(within(dialog).getByText("2 of 2+")).toBeTruthy());

    // Past the last loaded image the next page is needed, and it fails.
    await act(async () => {
      fireEvent.keyDown(document, { key: "ArrowRight" });
    });
    await waitFor(() => expect(within(dialog).getByText("Couldn't load more images: Internal error")).toBeTruthy());
    expect(within(dialog).getByText("2 of 2+")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("moves onto the next page from the viewer when it loads", async () => {
    serve({ pages: { first: { artifacts: range(1, 2), nextToken: "p2" }, p2: { artifacts: range(3, 3) } }, viewUrls: okUrls });
    render(<DeviceImageGallery device={DEVICE} />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "View Photo 2" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() => expect(within(dialog).getByText("3 of 3")).toBeTruthy());
    expect(within(dialog).getByRole("heading", { name: "Photo 3" })).toBeTruthy();
  });

  it("replaces an image's file from the viewer and shows the new file, not a cached old one", async () => {
    // jsdom's Blob has no arrayBuffer() (every browser does).
    if (!Blob.prototype.arrayBuffer) {
      Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
        return new Promise<ArrayBuffer>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.readAsArrayBuffer(this);
        });
      };
    }
    URL.createObjectURL = vi.fn(() => "blob:new-preview");
    URL.revokeObjectURL = vi.fn();
    serve({
      pages: { first: { artifacts: range(1, 2) } },
      // Each view-URL request signs a different URL, as the real endpoint does.
      viewUrls: (ids, call) =>
        ids.map((artifactId) => ({ ...okUrls([artifactId])[0], url: `https://s3.example/${artifactId}?call=${call}` } as ViewUrlResult)),
    });
    const routed = request.getMockImplementation()!;
    request.mockImplementation(async (method, path, options) => {
      if (path === "/artifacts/img-01/replacement") {
        return { artifactId: "img-01", replacementId: "r-1", upload: { mode: "single", url: "https://s3", fields: {} } };
      }
      if (path === "/artifacts/img-01/replacement/complete") {
        return {
          artifactId: "img-01", replacementId: "r-1", cleanupPending: false,
          image: { ...image(1), attemptId: "r-1", sha256: "b".repeat(64), sizeBytes: 12, originalFilename: "hires.png",
                   uploadedAt: "2026-11-02T00:00:00+00:00", updatedAt: "2026-11-02T00:00:00+00:00" },
        };
      }
      return routed(method, path, options);
    });
    render(<DeviceImageGallery device={DEVICE} />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    const oldSrc = screen.getByAltText("Photo 1").getAttribute("src");

    fireEvent.click(screen.getByRole("button", { name: "View Photo 1" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Replace image" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/permanently deletes the current file/)).toBeTruthy();
    const input = within(dialog).getByLabelText("New image file");
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])], "hires.png",
      { type: "image/png" });
    Object.defineProperty(input, "files", { value: [png], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(within(dialog).getByAltText("New file for Photo 1")).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace image" }));

    await waitFor(() => expect(screen.getByText(/Replaced the file of Photo 1\. The original file was permanently deleted/)).toBeTruthy());
    // A new URL was asked for this image alone, and both the grid and the
    // reopened viewer show it rather than the old file's.
    await waitFor(() => expect(viewUrlRequests().at(-1)).toEqual(["img-01"]));
    await waitFor(() => {
      const shown = screen.getAllByAltText("Photo 1").map((img) => img.getAttribute("src"));
      expect(shown.length).toBe(2);
      for (const src of shown) expect(src).not.toBe(oldSrc);
    });
    const viewer = screen.getByRole("dialog");
    expect(within(viewer).getByRole("heading", { name: "Photo 1" })).toBeTruthy();
    expect(within(viewer).getByText(/hires\.png · PNG/)).toBeTruthy();
    expect(screen.getAllByAltText("Photo 2")[0].getAttribute("src")).toBe("https://s3.example/img-02?call=1");
  });

  it("shows empty and error states", async () => {
    serve({ pages: { first: { artifacts: [] } }, viewUrls: okUrls });
    render(<DeviceImageGallery device={DEVICE} />);
    await waitFor(() => expect(screen.getByText("No images for this device yet")).toBeTruthy());
    expect(viewUrlRequests()).toEqual([]);
    cleanup();

    serve({ pages: { first: new ApiError("Forbidden", 403) }, viewUrls: okUrls });
    render(<DeviceImageGallery device={DEVICE} />);
    await waitFor(() => expect(screen.getByText(/don't have access/)).toBeTruthy());
  });
});
