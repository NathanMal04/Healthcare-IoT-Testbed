// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ ApiError: class extends Error {}, apiRequest: vi.fn() }));
vi.mock("@/context/WorkspaceContext", () => ({
  useWorkspace: () => ({ scopeLocked: false }),
  useScopeLock: () => undefined,
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: null, loading: false }) }));
// Hashing (wasm) and the S3 transfer (XHR) aren't what's tested here.
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  sha256File: vi.fn(async () => "a".repeat(64)),
  transferArtifact: vi.fn(async (_file: File, presigned: { attemptId: string }) => presigned.attemptId),
}));
// The byte check is held per file name when a test asks, to order it against the upload.
const heldChecks = new Map<string, (result: { ok: true; mimeType: "image/png" }) => void>();
vi.mock("@/lib/images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/images")>();
  return {
    ...actual,
    checkImageFile: vi.fn(async (file: File) => {
      if (file.name.startsWith("held-")) {
        return new Promise((resolve) => heldChecks.set(file.name, resolve));
      }
      return actual.checkImageFile(file);
    }),
  };
});

import { apiRequest } from "@/lib/api";
import type { Device } from "@/lib/devices";
import ArtifactUploader from "./ArtifactUploader";

const request = vi.mocked(apiRequest);
const DEVICE = { deviceId: "11111111-1111-4111-8111-111111111111", name: "Infusion pump", role: "owner" } as Device;
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

function png(name: string): File {
  return new File([PNG], name, { type: "image/png", lastModified: 1 });
}

function choose(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

/** The staged images' paths, from their title fields' labels. */
function staged(): string[] {
  return screen.queryAllByText(/^Title for /).map((label) => label.textContent!.replace("Title for ", ""));
}

function presignedNames(): string[][] {
  return request.mock.calls
    .filter(([method, path]) => method === "POST" && path === "/artifacts/presign")
    .map(([, , options]) => (options!.body as { files: { originalFilename: string }[] }).files.map((f) => f.originalFilename));
}

beforeEach(() => {
  heldChecks.clear();
  request.mockReset();
  request.mockImplementation(async (_method: string, path: string, options?: { body?: unknown }) => {
    if (path === "/artifacts/presign") {
      const { files } = options!.body as { files: { clientRef: string }[] };
      return {
        uploadBatchId: "batch-1",
        results: files.map((f) => ({
          clientRef: f.clientRef, ok: true, artifactId: `artifact-${f.clientRef}`, attemptId: "attempt-1",
          status: "pending", upload: { mode: "single", url: "https://s3", fields: {} },
        })),
      };
    }
    if (path === "/artifacts/complete") {
      const { items } = options!.body as { items: { artifactId: string; attemptId: string }[] };
      return { results: items.map((i) => ({ ...i, ok: true, status: "ready", statusReason: null, uploadedAt: null })) };
    }
    throw new Error(`unexpected ${path}`);
  });
  // jsdom has no object URLs; the previews only need a string.
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

function renderUploader(onFinished = vi.fn()) {
  const view = render(<ArtifactUploader devices={[DEVICE]} fixedDevice={DEVICE} fixedType="image" onFinished={onFinished} />);
  return { ...view, onFinished };
}

describe("ArtifactUploader (images)", () => {
  it("stages a file chosen twice in quick succession only once", async () => {
    const { container } = renderUploader();
    // The first check is still running when the same file is chosen again.
    choose(container, [png("held-board.png")]);
    choose(container, [png("held-board.png")]);
    await act(async () => heldChecks.get("held-board.png")!({ ok: true, mimeType: "image/png" }));
    await waitFor(() => expect(staged()).toEqual(["held-board.png"]));
    expect(screen.getByText(/held-board\.png \(already added\)/)).toBeTruthy();
    // Chosen again after staging: still refused.
    choose(container, [png("held-board.png")]);
    await waitFor(() => expect(screen.getAllByText(/already added/)).toHaveLength(1));
    expect(screen.getByText(/Skipped 2 files/)).toBeTruthy();
    expect(staged()).toEqual(["held-board.png"]);
  });

  it("keeps per-file validation errors and accepts the valid images", async () => {
    const { container } = renderUploader();
    choose(container, [
      png("top.png"),
      new File([new TextEncoder().encode("<svg></svg>")], "logo.png", { type: "image/png" }),
      new File([], "empty.png", { type: "image/png" }),
    ]);
    await waitFor(() => expect(staged()).toEqual(["top.png"]));
    expect(screen.getByText(/logo\.png \(not a JPEG, PNG or WebP image\)/)).toBeTruthy();
    expect(screen.getByText(/empty\.png \(empty\)/)).toBeTruthy();
    // A refused file can be chosen again (e.g. after fixing it): it isn't reserved.
    choose(container, [new File([PNG], "logo.png", { type: "image/png" })]);
    await waitFor(() => expect(staged()).toEqual(["top.png", "logo.png"]));
  });

  it("reports a file that can't be read and lets it be chosen again", async () => {
    const { container } = renderUploader();
    const unreadable = png("gone.png");
    unreadable.slice = () => {
      throw new Error("NotReadableError");
    };
    choose(container, [unreadable]);
    await waitFor(() => expect(screen.getByText(/gone\.png \(couldn't be read\)/)).toBeTruthy());
    expect(staged()).toEqual([]);
    choose(container, [png("gone.png")]);
    await waitFor(() => expect(staged()).toEqual(["gone.png"]));
  });

  it("never adds a file whose check finishes after the upload started", async () => {
    const { container, onFinished } = renderUploader();
    choose(container, [png("ready.png")]);
    await waitFor(() => expect(staged()).toEqual(["ready.png"]));
    choose(container, [png("held-late.png")]);

    fireEvent.click(screen.getByRole("button", { name: "Upload 1 image" }));
    await act(async () => heldChecks.get("held-late.png")!({ ok: true, mimeType: "image/png" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith("batch-1", 0));

    expect(staged()).toEqual(["ready.png"]);
    expect(presignedNames()).toEqual([["ready.png"]]);
    expect(screen.getByText(/held-late\.png \(chosen after the upload started; add it to a new upload\)/)).toBeTruthy();
  });

  it("drops checks that finish after Clear", async () => {
    const { container } = renderUploader();
    choose(container, [png("first.png")]);
    await waitFor(() => expect(staged()).toEqual(["first.png"]));
    choose(container, [png("held-second.png")]);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await act(async () => heldChecks.get("held-second.png")!({ ok: true, mimeType: "image/png" }));
    expect(staged()).toEqual([]);
    expect(screen.queryByText(/held-second/)).toBeNull();
    // A cleared file can be chosen again.
    choose(container, [png("first.png")]);
    await waitFor(() => expect(staged()).toEqual(["first.png"]));
  });

  it("uploads each image with its metadata and the shared capture date, linked to the device", async () => {
    const { container, onFinished } = renderUploader();
    choose(container, [png("a.png"), png("b.png")]);
    await waitFor(() => expect(staged()).toEqual(["a.png", "b.png"]));
    fireEvent.change(screen.getByLabelText("Title for a.png"), { target: { value: "UART header" } });
    fireEvent.change(screen.getByLabelText("Capture date for b.png"), { target: { value: "2024-02-03" } });
    fireEvent.change(screen.getByLabelText(/Captured on \(all images/), { target: { value: "2024-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload 2 images" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith("batch-1", 0));

    const [presign] = request.mock.calls.filter(([, path]) => path === "/artifacts/presign");
    const body = presign[2]!.body as { deviceIds: string[]; files: Record<string, unknown>[] };
    expect(body.deviceIds).toEqual([DEVICE.deviceId]);
    expect(body.files).toEqual([
      expect.objectContaining({ originalFilename: "a.png", type: "image", mimeType: "image/png", title: "UART header", capturedAt: "2024-01-01" }),
      expect.objectContaining({ originalFilename: "b.png", type: "image", mimeType: "image/png", capturedAt: "2024-02-03" }),
    ]);
    expect(body.files[1]).not.toHaveProperty("title");
  });

  it("refuses an invalid capture date before uploading", async () => {
    const { container } = renderUploader();
    choose(container, [png("a.png")]);
    await waitFor(() => expect(staged()).toEqual(["a.png"]));
    fireEvent.change(screen.getByLabelText("Capture date for a.png"), { target: { value: "1960-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload 1 image" }));
    expect(screen.getByText("a.png: Captured date can't be before 1970")).toBeTruthy();
    expect(presignedNames()).toEqual([]);
  });
});
