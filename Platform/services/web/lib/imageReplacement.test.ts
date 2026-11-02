import { beforeEach, describe, expect, it, vi } from "vitest";

// Replacing an image's file (lib/images.ts replaceImageFile): the request
// order, the attempt the replacement is made against, and which failures are
// retried. Hashing (wasm) and the S3 transfer (XHR) are stubbed.

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
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  sha256File: vi.fn(async () => "b".repeat(64)),
  sendSingleUpload: vi.fn(async () => undefined),
}));

import { ApiError, apiRequest } from "@/lib/api";
import { sendSingleUpload, sha256File } from "@/lib/artifacts";
import {
  applyImageReplacement,
  imageFileKey,
  replaceImageFile,
  type ImageArtifact,
  type ImageReplacementResult,
} from "@/lib/images";

const request = vi.mocked(apiRequest);
const send = vi.mocked(sendSingleUpload);
const hash = vi.mocked(sha256File);

const IMAGE = {
  artifactId: "img-1", name: "board.png", type: "image", status: "ready", title: "Main board",
  description: "Top side", mimeType: "image/png", capturedAt: "2024-03-02", updatedAt: null,
  attemptId: "attempt-old", sha256: "a".repeat(64), sizeBytes: 1000, originalFilename: "board.png",
  tags: ["teardown"], deviceIds: ["dev-1"], uploadedAt: "2026-10-01T00:00:00+00:00", workspaceId: "ws-1",
} as ImageArtifact;

const UPLOAD = { mode: "single" as const, url: "https://s3", fields: { key: "artifacts/img-1/r-1" } };

function result(overrides: Partial<ImageReplacementResult["image"]> = {}): ImageReplacementResult {
  return {
    artifactId: "img-1", replacementId: "r-1", cleanupPending: false,
    image: {
      artifactId: "img-1", attemptId: "r-1", status: "ready", sha256: "b".repeat(64), sizeBytes: 2000,
      originalFilename: "board-hires.jpg", uploadedAt: "2026-11-02T00:00:00+00:00", title: "Main board",
      description: "Top side", mimeType: "image/jpeg", capturedAt: "2024-03-02", updatedAt: "2026-11-02T00:00:00+00:00",
      ...overrides,
    },
  };
}

const file = () => new File([new Uint8Array(2000)], "board-hires.jpg", { type: "image/jpeg" });

beforeEach(() => {
  request.mockReset();
  send.mockReset().mockResolvedValue(undefined);
  hash.mockReset().mockResolvedValue("b".repeat(64));
});

describe("replaceImageFile", () => {
  it("hashes, starts against the attempt the user saw, uploads, then completes", async () => {
    request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: UPLOAD })
      .mockResolvedValueOnce(result());
    const stages: string[] = [];
    const done = await replaceImageFile(IMAGE, file(), "image/jpeg", { onStage: (s) => stages.push(s) });

    expect(stages).toEqual(["hashing", "uploading", "verifying"]);
    expect(request.mock.calls).toEqual([
      ["POST", "/artifacts/img-1/replacement", { body: {
        originalFilename: "board-hires.jpg", sizeBytes: 2000, sha256: "b".repeat(64), mimeType: "image/jpeg",
        expectedAttemptId: "attempt-old",
      } }],
      ["POST", "/artifacts/img-1/replacement/complete", { body: { replacementId: "r-1" } }],
    ]);
    expect(send).toHaveBeenCalledWith(expect.any(File), UPLOAD, expect.any(Function), undefined);
    expect(done.image.attemptId).toBe("r-1");
  });

  it("refuses the file that is already the image, before starting anything", async () => {
    hash.mockResolvedValue("a".repeat(64));
    await expect(replaceImageFile(IMAGE, file(), "image/jpeg")).rejects.toThrow("same file as the current image");
    expect(request).not.toHaveBeenCalled();
  });

  it("doesn't complete when the upload fails", async () => {
    request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: UPLOAD });
    send.mockRejectedValue(new Error("Network error during upload"));
    await expect(replaceImageFile(IMAGE, file(), "image/jpeg")).rejects.toThrow("Network error");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries a completion that only needs a moment, but not a rejection", async () => {
    request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: UPLOAD })
      .mockRejectedValueOnce(new ApiError("Uploaded file not found yet; retry once the upload has completed", 409))
      .mockRejectedValueOnce(new ApiError("Could not read the uploaded file; try again", 409))
      .mockResolvedValueOnce(result());
    await expect(replaceImageFile(IMAGE, file(), "image/jpeg", { retryDelayMs: 0 })).resolves.toMatchObject({
      replacementId: "r-1",
    });
    expect(request).toHaveBeenCalledTimes(4);

    for (const rejection of [
      new ApiError("Uploaded file is not a valid image/jpeg image; the current image was kept", 422),
      new ApiError("Another replacement was started at the same time; start again", 409),
      new ApiError("Artifact not found", 404),
    ]) {
      request.mockReset();
      request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: UPLOAD })
        .mockRejectedValueOnce(rejection);
      await expect(replaceImageFile(IMAGE, file(), "image/jpeg", { retryDelayMs: 0 })).rejects.toBe(rejection);
      expect(request).toHaveBeenCalledTimes(2);
    }
  });

  it("gives up after three completion attempts", async () => {
    const notYet = new ApiError("Uploaded file not found yet; retry once the upload has completed", 409);
    request.mockResolvedValueOnce({ artifactId: "img-1", replacementId: "r-1", upload: UPLOAD })
      .mockRejectedValue(notYet);
    await expect(replaceImageFile(IMAGE, file(), "image/jpeg", { retryDelayMs: 0 })).rejects.toBe(notYet);
    expect(request).toHaveBeenCalledTimes(4);
  });
});

describe("applyImageReplacement", () => {
  it("takes the new file and keeps everything the user wrote", () => {
    const replaced = applyImageReplacement(IMAGE, result().image);
    expect(replaced).toMatchObject({
      artifactId: "img-1", attemptId: "r-1", sha256: "b".repeat(64), sizeBytes: 2000, mimeType: "image/jpeg",
      originalFilename: "board-hires.jpg", title: "Main board", description: "Top side", capturedAt: "2024-03-02",
      tags: ["teardown"], deviceIds: ["dev-1"], workspaceId: "ws-1", name: "board.png",
    });
    expect(imageFileKey(replaced)).not.toBe(imageFileKey(IMAGE));
  });
});
