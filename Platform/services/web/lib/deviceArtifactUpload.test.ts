import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/api pulls in Amplify; only apiRequest is needed, as a mock.
vi.mock("@/lib/api", () => ({ apiRequest: vi.fn() }));
// The S3 transfer is XHR; here it just reports the attempt it was given.
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  transferArtifact: vi.fn(async (_file: File, presigned: { attemptId: string }) => presigned.attemptId),
}));

import { apiRequest } from "@/lib/api";
import { listDeviceArtifacts } from "@/lib/artifacts";
import { UploadQueue, type QueueItem } from "@/lib/uploadQueue";

// Device page → Artifacts tab → "Upload new artifact", as the tab does it:
// ArtifactUploader with fixedDevice set queues every file with that one
// device, and the tab reloads the device's list when the run ends, closing
// the uploader only when nothing failed.

const request = vi.mocked(apiRequest);
const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";

function item(name: string): QueueItem {
  return {
    id: name,
    file: new File(["capture bytes"], name),
    path: name,
    type: "pcap",
    version: "",
    stage: "queued",
    progress: 0,
  };
}

/** The deviceIds of every presign request. */
function presignedDeviceIds(): unknown[] {
  return request.mock.calls
    .filter(([method, path]) => method === "POST" && path === "/artifacts/presign")
    .map(([, , options]) => (options?.body as { deviceIds?: string[] }).deviceIds);
}

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (_method: string, path: string, options?: { body?: unknown }) => {
    if (path === "/artifacts/presign") {
      const { files } = options!.body as { files: { clientRef: string }[] };
      return {
        uploadBatchId: "batch-1",
        results: files.map((f) => ({
          clientRef: f.clientRef,
          ok: true,
          artifactId: `artifact-${f.clientRef}`,
          attemptId: "attempt-1",
          status: "pending",
          upload: { mode: "single", url: "https://s3", fields: {} },
        })),
      };
    }
    if (path === "/artifacts/complete") {
      const { items } = options!.body as { items: { artifactId: string; attemptId: string }[] };
      return { results: items.map((i) => ({ ...i, ok: true, status: "ready", statusReason: null, uploadedAt: "now" })) };
    }
    return { artifacts: [] };
  });
});

describe("Upload from a device's Artifacts tab", () => {
  it("links every uploaded file to Device A, and only Device A", async () => {
    // What ArtifactUploader queues with fixedDevice set to Device A.
    const queue = new UploadQueue([item("a.pcap"), item("b.pcap")], { tags: [], deviceIds: [DEVICE_A] });
    await queue.start();

    expect(presignedDeviceIds()).toEqual([[DEVICE_A]]);
    expect(queue.batchId).toBe("batch-1");
    // Nothing failed, so the tab closes the uploader.
    expect(queue.failedCount).toBe(0);
  });

  it("reloads Device A's own artifact list", async () => {
    await listDeviceArtifacts(DEVICE_A, { limit: 100 });
    expect(request).toHaveBeenCalledWith("GET", `/devices/${DEVICE_A}/artifacts`, { query: { limit: 100 } });
  });

  it("counts a refused device as failures, so the uploader stays for review or retry", async () => {
    request.mockRejectedValueOnce(new Error("Not authorized for device"));
    const queue = new UploadQueue([item("a.pcap"), item("b.pcap")], { tags: [], deviceIds: [DEVICE_A] });
    await queue.start();
    expect(queue.failedCount).toBe(2);
  });

  it("counts only the files that failed", async () => {
    request.mockImplementationOnce(async () => ({
      uploadBatchId: "batch-1",
      results: [
        { clientRef: "a.pcap", ok: false, status: 400, error: "Invalid file" },
        {
          clientRef: "b.pcap",
          ok: true,
          artifactId: "artifact-b",
          attemptId: "attempt-1",
          status: "pending",
          upload: { mode: "single", url: "https://s3", fields: {} },
        },
      ],
    }));
    const queue = new UploadQueue([item("a.pcap"), item("b.pcap")], { tags: [], deviceIds: [DEVICE_A] });
    await queue.start();
    expect(queue.failedCount).toBe(1);
  });

  it("counts cancelled files as failed", async () => {
    const queue = new UploadQueue([item("a.pcap")], { tags: [], deviceIds: [DEVICE_A] });
    const run = queue.start();
    queue.cancel();
    await run;
    expect(queue.failedCount).toBe(1);
  });
});

describe("Upload from the general Artifacts page", () => {
  it("can stay unassociated", async () => {
    const queue = new UploadQueue([item("capture.pcap")], { tags: [], deviceIds: [] });
    await queue.start();
    expect(presignedDeviceIds()).toEqual([[]]);
    expect(queue.failedCount).toBe(0);
  });

  it("can still link devices the user picks", async () => {
    const queue = new UploadQueue([item("capture.pcap")], { tags: ["lab"], deviceIds: [DEVICE_A, DEVICE_B] });
    await queue.start();
    expect(presignedDeviceIds()).toEqual([[DEVICE_A, DEVICE_B]]);
  });
});
