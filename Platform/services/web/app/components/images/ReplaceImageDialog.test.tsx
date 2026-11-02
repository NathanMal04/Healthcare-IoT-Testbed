// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { ApiError, apiRequest: vi.fn() };
});
vi.mock("@/context/WorkspaceContext", () => ({ useScopeLock: () => undefined }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: null, loading: false }) }));
// Hashing (wasm) and the S3 transfer (XHR) aren't what's tested here.
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  sha256File: vi.fn(async () => "b".repeat(64)),
  sendSingleUpload: vi.fn(async () => undefined),
}));

import { ApiError, apiRequest } from "@/lib/api";
import { sendSingleUpload } from "@/lib/artifacts";
import type { ImageArtifact } from "@/lib/images";
import type { ImageUrls } from "./useImageData";
import ReplaceImageDialog from "./ReplaceImageDialog";

const request = vi.mocked(apiRequest);
const send = vi.mocked(sendSingleUpload);

// jsdom's Blob has no arrayBuffer() (every browser does); read through FileReader instead.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const IMAGE = {
  artifactId: "img-1", name: "board.png", type: "image", status: "ready", title: "Main board",
  description: "Top side", mimeType: "image/jpeg", capturedAt: "2024-03-02", updatedAt: null,
  attemptId: "attempt-old", sha256: "a".repeat(64), sizeBytes: 1000, originalFilename: "board.jpg",
  tags: ["teardown"], deviceIds: ["dev-1"], uploadedAt: null,
} as ImageArtifact;

const urls: ImageUrls = {
  get: () => ({ status: "ready", url: "https://s3.example/old?sig", expiresAt: Date.now() + 300_000, stale: false }),
  ensure: vi.fn(),
  reportError: vi.fn(),
  isBroken: () => false,
  problemCount: 0,
  error: null,
  retry: vi.fn(),
  refresh: vi.fn(),
};

function completed(cleanupPending = false) {
  return {
    artifactId: "img-1", replacementId: "r-1", cleanupPending,
    image: {
      artifactId: "img-1", attemptId: "r-1", status: "ready", sha256: "b".repeat(64), sizeBytes: 12,
      originalFilename: "board-hires.png", uploadedAt: "2026-11-02T00:00:00+00:00", title: "Main board",
      description: "Top side", mimeType: "image/png", capturedAt: "2024-03-02", updatedAt: "2026-11-02T00:00:00+00:00",
    },
  };
}

function choose(file: File) {
  const input = screen.getByLabelText("New image file");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

const png = (name = "board-hires.png") => new File([PNG], name, { type: "image/png" });
const replaceButton = () => screen.getByRole("button", { name: "Replace image" }) as HTMLButtonElement;
const confirmBox = () => screen.getByRole("checkbox") as HTMLInputElement;

function renderDialog() {
  const onReplaced = vi.fn();
  const onClose = vi.fn();
  render(<ReplaceImageDialog image={IMAGE} urls={urls} onClose={onClose} onReplaced={onReplaced} />);
  return { onReplaced, onClose };
}

async function chooseAndConfirm(file = png()) {
  choose(file);
  await waitFor(() => expect(screen.getByAltText("New file for Main board")).toBeTruthy());
  fireEvent.click(confirmBox());
}

beforeEach(() => {
  request.mockReset();
  send.mockReset().mockResolvedValue(undefined);
  URL.createObjectURL = vi.fn(() => "blob:new-preview");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("ReplaceImageDialog", () => {
  it("warns about permanent deletion and needs a checked file, its preview and a confirmation", async () => {
    renderDialog();
    expect(screen.getByText(/permanently deletes the current file/)).toBeTruthy();
    expect(screen.getByText(/no version history/)).toBeTruthy();
    expect(screen.getByAltText("Main board").getAttribute("src")).toBe("https://s3.example/old?sig");
    expect(replaceButton().disabled).toBe(true);
    expect(confirmBox().disabled).toBe(true);

    choose(png());
    await waitFor(() => expect(screen.getByAltText("New file for Main board").getAttribute("src")).toBe("blob:new-preview"));
    expect(screen.getByText(/board-hires\.png · PNG/)).toBeTruthy();
    expect(replaceButton().disabled).toBe(true); // not confirmed yet
    fireEvent.click(confirmBox());
    expect(replaceButton().disabled).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses files that aren't JPEG, PNG or WebP images of at most 25 MiB", async () => {
    renderDialog();
    const cases: [File, RegExp][] = [
      [new File([new TextEncoder().encode("<svg></svg>")], "logo.png", { type: "image/png" }), /not a JPEG, PNG or WebP image/],
      [new File([new TextEncoder().encode("GIF89a......")], "anim.gif", { type: "image/gif" }), /not a JPEG, PNG or WebP image/],
      [new File([], "empty.png", { type: "image/png" }), /empty/],
    ];
    const big = png("huge.png");
    Object.defineProperty(big, "size", { value: 25 * 1024 ** 2 + 1 });
    cases.push([big, /over 25 MiB/]);
    for (const [file, reason] of cases) {
      choose(file);
      await waitFor(() => expect(screen.getByText(reason)).toBeTruthy());
      expect(screen.queryByAltText("New file for Main board")).toBeNull();
      expect(confirmBox().disabled).toBe(true);
      expect(replaceButton().disabled).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("replaces the file and hands back the image with its details unchanged", async () => {
    request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: { mode: "single", url: "https://s3", fields: {} } })
      .mockResolvedValueOnce(completed());
    const { onReplaced } = renderDialog();
    await chooseAndConfirm();
    fireEvent.click(replaceButton());
    await waitFor(() => expect(onReplaced).toHaveBeenCalled());

    const [image, cleanupPending] = onReplaced.mock.calls[0];
    expect(cleanupPending).toBe(false);
    expect(image).toMatchObject({
      artifactId: "img-1", attemptId: "r-1", mimeType: "image/png", originalFilename: "board-hires.png",
      title: "Main board", description: "Top side", capturedAt: "2024-03-02", tags: ["teardown"], deviceIds: ["dev-1"],
    });
    expect(request.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual([
      "POST /artifacts/img-1/replacement",
      "POST /artifacts/img-1/replacement/complete",
    ]);
    expect((request.mock.calls[0][2]!.body as { expectedAttemptId: string }).expectedAttemptId).toBe("attempt-old");
  });

  it("keeps the current image when verification fails, and can try again", async () => {
    request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: { mode: "single", url: "https://s3", fields: {} } })
      .mockRejectedValueOnce(new ApiError("Uploaded file is not a valid image/png image; the current image was kept", 422))
      .mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-2", upload: { mode: "single", url: "https://s3", fields: {} } })
      .mockResolvedValueOnce(completed());
    const { onReplaced, onClose } = renderDialog();
    await chooseAndConfirm();
    fireEvent.click(replaceButton());
    await waitFor(() =>
      expect(screen.getByText("Uploaded file is not a valid image/png image. The current image was kept.")).toBeTruthy()
    );
    expect(onReplaced).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(replaceButton());
    await waitFor(() => expect(onReplaced).toHaveBeenCalled());
  });

  it("refuses a file that someone else's replacement made stale", async () => {
    request.mockRejectedValueOnce(
      new ApiError("This image has changed since it was loaded (it may have been replaced); reload it and try again", 409)
    );
    const { onReplaced } = renderDialog();
    await chooseAndConfirm();
    fireEvent.click(replaceButton());
    await waitFor(() =>
      expect(screen.getByText(/^This image was changed since the gallery loaded it .* Refresh the gallery and try again\. The current image was kept\.$/)).toBeTruthy()
    );
    expect(send).not.toHaveBeenCalled();
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it("cancels an upload without completing it", async () => {
    request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: { mode: "single", url: "https://s3", fields: {} } });
    send.mockImplementation((_file, _upload, _progress, signal) =>
      new Promise((_, reject) =>
        signal!.addEventListener("abort", () => reject(new DOMException("Upload cancelled", "AbortError")))
      )
    );
    const { onReplaced } = renderDialog();
    await chooseAndConfirm();
    fireEvent.click(replaceButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel upload" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    await waitFor(() => expect(screen.getByText("Replacement cancelled. The current image was kept.")).toBeTruthy());
    expect(request).toHaveBeenCalledTimes(1); // never completed
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it("says the outcome is unknown when completing it fails without an answer", async () => {
    request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: { mode: "single", url: "https://s3", fields: {} } })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderDialog();
    await chooseAndConfirm();
    fireEvent.click(replaceButton());
    await waitFor(() => expect(screen.getByText(/^Couldn't confirm whether the image was replaced\. Refresh the gallery/)).toBeTruthy());
    expect(screen.queryByText(/current image was kept/)).toBeNull();
  });

  it("never claims the old file was kept when completing it failed on the server", async () => {
    // The backend may have swapped the file in before failing, or the gateway timed out.
    for (const failure of [new ApiError("Internal server error", 500), new ApiError("Endpoint request timed out", 504)]) {
      request.mockReset();
      request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: { mode: "single", url: "https://s3", fields: {} } })
        .mockRejectedValueOnce(failure);
      renderDialog();
      await chooseAndConfirm();
      fireEvent.click(replaceButton());
      await waitFor(() => expect(screen.getByText(/^Couldn't confirm whether the image was replaced/)).toBeTruthy());
      expect(screen.queryByText(/current image was kept/)).toBeNull();
      cleanup();
    }
  });

  it("explains the backend's conflicts in terms of this dialog, as full sentences", async () => {
    const cases: [string, RegExp][] = [
      ["Uploaded file not found yet; retry once the upload has completed",
        /^The uploaded file couldn't be found to verify it\. Try again\. The current image was kept\.$/],
      ["Could not read the uploaded file; try again",
        /^The uploaded file couldn't be read to verify it\. Try again\. The current image was kept\.$/],
      ["This replacement is no longer current (another replacement was started, or it failed); start again",
        /^Another replacement of this image was started, so this one was cancelled\..* The current image was kept\.$/],
      ["Another replacement was started at the same time; start again",
        /^Another replacement of this image was started, so this one was cancelled\..* The current image was kept\.$/],
    ];
    for (const [serverMessage, shown] of cases) {
      request.mockReset();
      request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: { mode: "single", url: "https://s3", fields: {} } })
        // The two "try again" answers are retried; keep answering the same.
        .mockRejectedValue(new ApiError(serverMessage, 409));
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderDialog();
        await chooseAndConfirm();
        fireEvent.click(replaceButton());
        await vi.runAllTimersAsync();
        await waitFor(() => expect(screen.getByText(shown)).toBeTruthy());
      } finally {
        vi.useRealTimers();
        cleanup();
      }
    }
  });

  it("reports when the old file is still being deleted", async () => {
    request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: { mode: "single", url: "https://s3", fields: {} } })
      .mockResolvedValueOnce(completed(true));
    const { onReplaced } = renderDialog();
    await chooseAndConfirm();
    fireEvent.click(replaceButton());
    await waitFor(() => expect(onReplaced).toHaveBeenCalled());
    expect(onReplaced.mock.calls[0][1]).toBe(true);
  });
});
