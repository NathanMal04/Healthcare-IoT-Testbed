import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/api pulls in Amplify; only apiRequest is needed, as a mock.
vi.mock("@/lib/api", () => ({ ApiError: class extends Error {}, apiRequest: vi.fn() }));
// The S3 transfer is XHR; here it just reports the attempt it was given, or fails once when asked.
const transferFailures = new Set<string>();
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  transferArtifact: vi.fn(async (file: File, presigned: { attemptId: string }) => {
    if (transferFailures.delete(file.name)) throw new Error("Network error during upload");
    return presigned.attemptId;
  }),
}));

import { apiRequest } from "@/lib/api";
import { UploadQueue, imagePresignFields, type QueueItem } from "@/lib/uploadQueue";

// Device page → Images tab → "Upload images": ArtifactUploader with
// fixedType "image" and fixedDevice queues every image with its detected
// format and optional metadata, linked to the one device, which decides the
// upload's scope (personal or that device's workspace).

const request = vi.mocked(apiRequest);
const DEVICE = "11111111-1111-4111-8111-111111111111";

function imageItem(name: string, image: QueueItem["image"] = { mimeType: "image/png" }): QueueItem {
  return {
    id: name,
    file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name),
    path: name,
    type: "image",
    version: "",
    image,
    stage: "queued",
    progress: 0,
  };
}

function presignBodies() {
  return request.mock.calls
    .filter(([method, path]) => method === "POST" && path === "/artifacts/presign")
    .map(([, , options]) => options?.body as { deviceIds: string[]; files: Record<string, unknown>[] });
}

beforeEach(() => {
  transferFailures.clear();
  request.mockReset();
  request.mockImplementation(async (_method: string, path: string, options?: { body?: unknown }) => {
    if (path === "/artifacts/presign") {
      const { files } = options!.body as { files: { clientRef: string; mimeType?: string }[] };
      return {
        uploadBatchId: "batch-1",
        results: files.map((f) =>
          f.clientRef === "refused.png"
            ? { clientRef: f.clientRef, ok: false, status: 400, error: "Images can be at most 26214400 bytes" }
            : {
                clientRef: f.clientRef, ok: true, artifactId: `artifact-${f.clientRef}`, attemptId: "attempt-1",
                status: "pending", upload: { mode: "single", url: "https://s3", fields: { "Content-Type": f.mimeType } },
              }
        ),
      };
    }
    if (path.endsWith("/retry")) {
      return { artifactId: path.split("/")[2], attemptId: "attempt-2", status: "pending", upload: { mode: "single", url: "https://s3", fields: {} } };
    }
    if (path === "/artifacts/complete") {
      const { items } = options!.body as { items: { artifactId: string; attemptId: string }[] };
      return { results: items.map((i) => ({ ...i, ok: true, status: "ready", statusReason: null, uploadedAt: null })) };
    }
    throw new Error(`unexpected ${path}`);
  });
});

describe("image upload queue", () => {
  it("sends each image's format and metadata, linked to the device", async () => {
    const queue = new UploadQueue(
      [
        imageItem("top.jpg", { mimeType: "image/jpeg", title: " Top side ", description: "UART pads\nnear J3", capturedAt: "2024-03-02" }),
        imageItem("bottom.png"),
      ],
      { tags: [], deviceIds: [DEVICE] }
    );
    await queue.start();
    expect(queue.failedCount).toBe(0);
    const [body] = presignBodies();
    expect(body.deviceIds).toEqual([DEVICE]);
    // No workspaceId is ever sent: the backend takes the scope from the device.
    expect(body).not.toHaveProperty("workspaceId");
    expect(body.files).toEqual([
      expect.objectContaining({
        type: "image", originalFilename: "top.jpg", mimeType: "image/jpeg",
        title: "Top side", description: "UART pads\nnear J3", capturedAt: "2024-03-02",
      }),
      expect.objectContaining({ type: "image", originalFilename: "bottom.png", mimeType: "image/png" }),
    ]);
    // Blank optional fields are left out, so the title defaults to the name.
    expect(body.files[1]).not.toHaveProperty("title");
    expect(body.files[1]).not.toHaveProperty("capturedAt");
    // Images never carry a firmware version.
    expect(body.files.map((f) => f.version)).toEqual([undefined, undefined]);
    expect(JSON.parse(JSON.stringify(body.files)).every((f: object) => !("version" in f))).toBe(true);
  });

  it("reports a refused image and finishes the others", async () => {
    const queue = new UploadQueue([imageItem("refused.png"), imageItem("ok.png")], { tags: [], deviceIds: [DEVICE] });
    const snapshots: QueueItem[][] = [];
    queue.subscribe((items) => snapshots.push(items));
    await queue.start();
    const last = snapshots[snapshots.length - 1];
    expect(last.map((i) => [i.id, i.stage, i.error])).toEqual([
      ["refused.png", "failed", "Images can be at most 26214400 bytes"],
      ["ok.png", "ready", undefined],
    ]);
  });

  it("retries a failed transfer through the retry endpoint, without registering the image twice", async () => {
    transferFailures.add("flaky.png");
    const queue = new UploadQueue([imageItem("flaky.png")], { tags: [], deviceIds: [DEVICE] });
    await queue.start();
    expect(queue.failedCount).toBe(1);
    await queue.start();
    expect(queue.failedCount).toBe(0);
    expect(presignBodies()).toHaveLength(1);
    const paths = request.mock.calls.map(([, path]) => path);
    expect(paths).toContain("/artifacts/artifact-flaky.png/retry");
  });

  it("leaves blank optional fields out of the presign request", () => {
    expect(imagePresignFields({ mimeType: "image/webp", title: "  ", description: "", capturedAt: "" })).toEqual({
      mimeType: "image/webp",
    });
  });

  it("doesn't add image fields to other types", async () => {
    const pcap: QueueItem = { ...imageItem("cap.pcap"), type: "pcap", image: undefined };
    const queue = new UploadQueue([pcap], { tags: [], deviceIds: [DEVICE] });
    await queue.start();
    const [body] = presignBodies();
    expect(body.files[0]).toEqual({
      clientRef: "cap.pcap", originalFilename: "cap.pcap", sizeBytes: 4, sha256: expect.any(String), type: "pcap", version: undefined,
    });
  });
});
