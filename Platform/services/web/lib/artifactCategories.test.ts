import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/api pulls in Amplify; only apiRequest is needed, as a mock.
vi.mock("@/lib/api", () => ({ apiRequest: vi.fn() }));
// The S3 transfer is XHR; here it just reports the attempt it was given.
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  transferArtifact: vi.fn(async (_file: File, presigned: { attemptId: string }) => presigned.attemptId),
}));

import { apiRequest } from "@/lib/api";
import {
  ARTIFACT_TYPES,
  ARTIFACT_TYPE_LABELS,
  guessArtifactType,
  listArtifacts,
  listDeviceArtifacts,
  stagedArtifactType,
  type ArtifactType,
} from "@/lib/artifacts";
import { UploadQueue, type QueueItem } from "@/lib/uploadQueue";

// Category tabs on the Artifacts page and a device's Artifacts tab, and the
// "Upload <category>" uploads they open: ArtifactUploader with fixedType
// stages every file with that type (stagedArtifactType), and the queue sends
// it through the usual presign → S3 → complete pipeline.

const request = vi.mocked(apiRequest);
const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const W1 = "0192b000-0000-7000-8000-000000000001";

/** A staged file, typed the way ArtifactUploader types it. */
function staged(name: string, fixedType?: ArtifactType, version = ""): QueueItem {
  return {
    id: name,
    file: new File(["bytes"], name),
    path: name,
    type: stagedArtifactType(name, fixedType),
    version,
    stage: "queued",
    progress: 0,
  };
}

/** The files and deviceIds of every presign request. */
function presigned(): { files: { originalFilename: string; type: string; version?: string }[]; deviceIds?: string[] }[] {
  return request.mock.calls
    .filter(([method, path]) => method === "POST" && path === "/artifacts/presign")
    .map(([, , options]) => options?.body as never);
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

describe("Artifact types", () => {
  it("keeps the original types and adds kernel modules and PDF reports", () => {
    for (const type of ["firmware", "binary", "pcap", "log", "other", "kernel_module", "report"]) {
      expect(ARTIFACT_TYPES).toContain(type);
    }
    expect(ARTIFACT_TYPES).toHaveLength(7);
  });

  it("has a category and an upload label for every type", () => {
    expect(ARTIFACT_TYPES.map((t) => ARTIFACT_TYPE_LABELS[t].category)).toEqual([
      "Firmware", "Binary", "PCAP", "Logs", "Kernel Modules", "PDF Reports", "Other",
    ]);
    expect(ARTIFACT_TYPE_LABELS.kernel_module.single).toBe("Kernel Module");
    expect(ARTIFACT_TYPE_LABELS.report.single).toBe("PDF Report");
    expect(ARTIFACT_TYPE_LABELS.log.single).toBe("Log");
  });
});

describe("Type from the file name", () => {
  it.each([
    ["netfilter.ko", "kernel_module"],
    ["DRIVER.KO", "kernel_module"],
    ["mod.v1.2.ko", "kernel_module"],
    ["findings.pdf", "report"],
    ["Report.Final.PDF", "report"],
    ["fw.bin", "firmware"],
    ["FW.BIN", "firmware"],
    ["capture.pcapng", "pcap"],
    ["capture.pcap", "pcap"],
    ["app.elf", "binary"],
    ["boot.log", "log"],
    ["mod.ko.xz", "other"],
    ["README", "other"],
    ["file.", "other"],
  ])("%s → %s", (name, type) => {
    expect(guessArtifactType(name)).toBe(type);
  });

  it("is only a suggestion without a fixed type", () => {
    expect(stagedArtifactType("nf.ko")).toBe("kernel_module");
    expect(stagedArtifactType("fw.bin")).toBe("firmware");
  });

  it("is overridden by a category upload's fixed type", () => {
    expect(stagedArtifactType("fw.bin", "binary")).toBe("binary");
    expect(stagedArtifactType("notes.txt", "pcap")).toBe("pcap");
    expect(stagedArtifactType("nf.ko", "report")).toBe("report");
  });
});

describe("Category filtering", () => {
  it("asks the existing type filter for the selected category", async () => {
    await listArtifacts({ type: "report", workspaceId: W1 });
    expect(request).toHaveBeenCalledWith("GET", "/artifacts", { query: { type: "report", workspaceId: W1 } });
  });

  it("filters a device's artifacts by category", async () => {
    await listDeviceArtifacts(DEVICE_A, { limit: 100, type: "kernel_module" });
    expect(request).toHaveBeenCalledWith("GET", `/devices/${DEVICE_A}/artifacts`, {
      query: { limit: 100, type: "kernel_module" },
    });
  });
});

describe("Category upload (fixed type)", () => {
  it("uploads every file with the category's type, whatever its name", async () => {
    const queue = new UploadQueue([staged("nf.ko", "kernel_module"), staged("helper.bin", "kernel_module")], {
      tags: [],
      deviceIds: [],
    });
    await queue.start();
    const [body] = presigned();
    expect(body.files.map((f) => [f.originalFilename, f.type, f.version])).toEqual([
      ["nf.ko", "kernel_module", undefined],
      ["helper.bin", "kernel_module", undefined],
    ]);
    expect(queue.failedCount).toBe(0);
  });

  it("keeps the device link from a device's tab (fixedDevice + fixedType)", async () => {
    const queue = new UploadQueue([staged("findings.pdf", "report")], { tags: [], deviceIds: [DEVICE_A] });
    await queue.start();
    const [body] = presigned();
    expect(body.deviceIds).toEqual([DEVICE_A]);
    expect(body.files[0].type).toBe("report");
  });

  it("still sends the firmware version for a firmware upload", async () => {
    const queue = new UploadQueue([staged("image.img", "firmware", "2.1.0")], { tags: [], deviceIds: [DEVICE_A] });
    await queue.start();
    expect(presigned()[0].files[0]).toMatchObject({ type: "firmware", version: "2.1.0" });
  });

  it("leaves the general upload flexible: guessed per file", async () => {
    const queue = new UploadQueue([staged("fw.bin", undefined, "1.0"), staged("nf.ko"), staged("r.pdf")], {
      tags: [],
      deviceIds: [],
    });
    await queue.start();
    expect(presigned()[0].files.map((f) => f.type)).toEqual(["firmware", "kernel_module", "report"]);
  });
});
