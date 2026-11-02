// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCallback, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
vi.mock("@/context/WorkspaceContext", () => ({
  useWorkspace: () => ({ scopeLocked: false }),
  useScopeLock: () => undefined,
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: null, loading: false }) }));
// Hashing (wasm) and S3 transfers (XHR) aren't what's tested here.
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  sha256File: vi.fn(async () => "b".repeat(64)),
  transferArtifact: vi.fn(async (_file: File, presigned: { attemptId: string }) => presigned.attemptId),
  sendSingleUpload: vi.fn(async () => undefined),
}));

import { ApiError, apiRequest } from "@/lib/api";
import type { Device } from "@/lib/devices";
import type { ImageArtifact, ViewUrlResult } from "@/lib/images";
import DeviceProfilePicture from "./DeviceProfilePicture";
import { useImageUrls } from "./useImageData";
import { useProfileImage } from "./useProfileImage";

const request = vi.mocked(apiRequest);
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const FIRST = "0192a000-0000-7000-8000-000000000001";
const SECOND = "0192a000-0000-7000-8000-000000000002";
const NEW = "artifact-new";

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
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function image(id: string, title: string, overrides: Partial<ImageArtifact> = {}): ImageArtifact {
  return {
    artifactId: id, name: `${title}.png`, type: "image", origin: "upload", version: null, status: "ready",
    statusReason: null, sizeBytes: 1000, sha256: "a".repeat(64), originalFilename: `${title}.png`, tags: [],
    deviceIds: [DEVICE_ID], uploadBatchId: "b", uploadMode: "single", attemptId: `attempt-${id}`,
    createdAt: "2026-10-01T10:00:00+00:00", uploadedAt: null, statusUpdatedAt: null,
    title, description: null, mimeType: "image/png", capturedAt: null, updatedAt: null, ...overrides,
  };
}

interface Server {
  images: ImageArtifact[];
  /** Ids the view-URL endpoint reports as unavailable. */
  unavailable?: Set<string>;
  /** Make the next PATCHes fail with these errors, in order. */
  patchFailures?: Error[];
}

/** Routes the component's API calls, and records the device the backend holds. */
function serve(server: Server) {
  let viewCalls = 0;
  const failures = [...(server.patchFailures ?? [])];
  request.mockImplementation(async (method: string, path: string, options?: { body?: unknown }) => {
    const body = options?.body as Record<string, unknown> | undefined;
    if (method === "GET" && path === `/devices/${DEVICE_ID}/artifacts`) return { artifacts: server.images };
    if (method === "POST" && path === "/artifacts/view-urls") {
      viewCalls++;
      return {
        results: (body!.artifactIds as string[]).map((artifactId): ViewUrlResult =>
          server.unavailable?.has(artifactId)
            ? { artifactId, ok: false, status: 404, error: "Image not found" }
            : { artifactId, ok: true, url: `https://s3.example/${artifactId}?call=${viewCalls}`, mimeType: "image/png", expiresIn: 300 }
        ),
      };
    }
    if (method === "PATCH" && path === `/devices/${DEVICE_ID}`) {
      const failure = failures.shift();
      if (failure) throw failure;
      const id = body!.profileImageArtifactId as string | null;
      return {
        deviceId: DEVICE_ID, name: "Infusion pump", reverseEngineeringStatus: "not_started", updatedAt: "now",
        ...(id ? { profileImageArtifactId: id } : {}),
      };
    }
    if (method === "GET" && path.startsWith("/artifacts/")) {
      const found = server.images.find((i) => path === `/artifacts/${i.artifactId}`);
      if (!found) throw new ApiError("Artifact not found", 404);
      return { artifact: { ...found, devices: [] } };
    }
    if (method === "POST" && path === "/artifacts/presign") {
      const files = (body!.files as { clientRef: string }[]);
      return {
        uploadBatchId: "batch-1",
        results: files.map((f) => ({ clientRef: f.clientRef, ok: true, artifactId: NEW, attemptId: "attempt-1",
          status: "pending", upload: { mode: "single", url: "https://s3", fields: {} } })),
      };
    }
    if (method === "POST" && path === "/artifacts/complete") {
      const { items } = body as { items: { artifactId: string; attemptId: string }[] };
      return { results: items.map((i) => ({ ...i, ok: true, status: "ready", statusReason: null, uploadedAt: null })) };
    }
    if (method === "POST" && path === `/artifacts/${FIRST}/replacement`) {
      return { artifactId: FIRST, replacementId: "r-1", upload: { mode: "single", url: "https://s3", fields: {} } };
    }
    if (method === "POST" && path === `/artifacts/${FIRST}/replacement/complete`) {
      const current = server.images.find((i) => i.artifactId === FIRST)!;
      return { artifactId: FIRST, replacementId: "r-1", cleanupPending: false,
        image: { ...current, attemptId: "r-1", sha256: "b".repeat(64), originalFilename: "hires.png" } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
}

function patches(): unknown[] {
  return request.mock.calls.filter(([method]) => method === "PATCH").map(([, , options]) => options?.body);
}

/** The page's wiring, without the rest of the page. */
function Harness({ initial, canEdit = true, onGalleryChanged = () => {} }: {
  initial: Device; canEdit?: boolean; onGalleryChanged?: () => void;
}) {
  const [device, setDevice] = useState(initial);
  const urls = useImageUrls(device.profileImageArtifactId ? [device.profileImageArtifactId] : []);
  const [version, setVersion] = useState(0);
  const update = useCallback((fn: (current: Device) => Device) => setDevice((current) => fn(current)), []);
  const profile = useProfileImage(device.deviceId, update);
  return (
    <>
      <DeviceProfilePicture
        device={device}
        canEdit={canEdit}
        urls={urls}
        fileVersion={version}
        profile={profile}
        onFileReplaced={(replaced) => {
          urls.refresh(replaced.artifactId);
          setVersion((v) => v + 1);
        }}
        onGalleryChanged={onGalleryChanged}
      />
      {profile.notice && <p>{profile.notice}</p>}
      {profile.error && <p role="alert">{profile.error}</p>}
      <p data-testid="device-picture">{device.profileImageArtifactId ?? "none"}</p>
    </>
  );
}

const DEVICE: Device = { deviceId: DEVICE_ID, name: "Infusion pump", role: "owner", reverseEngineeringStatus: "not_started" };

function openMenuItem(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Profile picture options" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

const devicePicture = () => screen.getByTestId("device-picture").textContent;

beforeEach(() => {
  request.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("DeviceProfilePicture", () => {
  it("shows the default icon without a picture, and the picture once chosen", async () => {
    serve({ images: [image(FIRST, "Main board")] });
    render(<Harness initial={DEVICE} />);
    expect(screen.getByRole("img", { name: "Profile picture of Infusion pump (no picture)" })).toBeTruthy();
    // No URL is asked for a device without a picture.
    expect(request).not.toHaveBeenCalled();
    cleanup();

    render(<Harness initial={{ ...DEVICE, profileImageArtifactId: FIRST }} />);
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Profile picture of Infusion pump" }).getAttribute("src")).toBe(
        `https://s3.example/${FIRST}?call=1`
      )
    );
  });

  it("offers no actions to someone who can't edit the device", () => {
    serve({ images: [] });
    render(<Harness initial={{ ...DEVICE, role: "viewer" }} canEdit={false} />);
    expect(screen.queryByRole("button", { name: "Profile picture options" })).toBeNull();
  });

  it("chooses another gallery image without changing either image", async () => {
    serve({ images: [image(FIRST, "Main board"), image(SECOND, "Label"), image("pending-1", "Pending", { status: "pending" })] });
    render(<Harness initial={{ ...DEVICE, profileImageArtifactId: FIRST }} />);
    openMenuItem("Change: choose from gallery");
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByRole("button", { name: /^(Select|Deselect) / })).toHaveLength(2));
    // Only ready images, and the current one is marked and selected.
    expect(within(dialog).queryByRole("button", { name: /Pending/ })).toBeNull();
    expect(within(dialog).getByText("Current picture")).toBeTruthy();
    const use = within(dialog).getByRole("button", { name: "Use as profile picture" }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: "Select Label" }));
    fireEvent.click(use);
    await waitFor(() => expect(screen.getByText("Label is now the profile picture.")).toBeTruthy());
    expect(patches()).toEqual([{ profileImageArtifactId: SECOND }]);
    expect(devicePicture()).toBe(SECOND);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Only the device was changed: no image was deleted, replaced or edited.
    expect(request.mock.calls.filter(([method, path]) => method !== "GET" && path !== "/artifacts/view-urls"))
      .toHaveLength(1);
  });

  it("keeps the picture and shows why when the backend refuses the choice", async () => {
    serve({
      images: [image(FIRST, "Main board"), image(SECOND, "Label")],
      patchFailures: [new ApiError(`profileImageArtifactId must be a ready image of this device`, 400)],
    });
    render(<Harness initial={{ ...DEVICE, profileImageArtifactId: FIRST }} />);
    openMenuItem("Change: choose from gallery");
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Select Label" })).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "Select Label" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Use as profile picture" }));
    await waitFor(() => expect(within(dialog).getByText(/must be a ready image of this device/)).toBeTruthy());
    expect(devicePicture()).toBe(FIRST);
    expect(screen.getByRole("dialog")).toBeTruthy(); // still open, to choose again
  });

  it("removes the picture and keeps the image", async () => {
    serve({ images: [image(FIRST, "Main board")] });
    render(<Harness initial={{ ...DEVICE, profileImageArtifactId: FIRST }} />);
    await waitFor(() => expect(screen.getByRole("img", { name: "Profile picture of Infusion pump" }).tagName).toBe("IMG"));
    openMenuItem("Remove profile picture");
    await waitFor(() => expect(screen.getByText(/Removed the profile picture\. The image is still in the gallery\./)).toBeTruthy());
    expect(patches()).toEqual([{ profileImageArtifactId: null }]);
    expect(devicePicture()).toBe("none");
    expect(screen.getByRole("img", { name: "Profile picture of Infusion pump (no picture)" })).toBeTruthy();
  });

  it("uploads a new picture through the gallery uploader and selects it once it is ready", async () => {
    serve({ images: [image(FIRST, "Main board")] });
    const onGalleryChanged = vi.fn();
    render(<Harness initial={{ ...DEVICE, profileImageArtifactId: FIRST }} onGalleryChanged={onGalleryChanged} />);
    openMenuItem("Change: upload new picture");
    const dialog = screen.getByRole("dialog");
    // One image only: no folder choice, and a second file is refused.
    expect(within(dialog).queryByRole("button", { name: "Choose folder" })).toBeNull();
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
    expect(input.multiple).toBe(false);
    Object.defineProperty(input, "files", {
      value: [new File([PNG], "new.png", { type: "image/png" }), new File([PNG], "extra.png", { type: "image/png" })],
      configurable: true,
    });
    fireEvent.change(input);
    await waitFor(() => expect(within(dialog).getByText(/extra\.png \(only one image can be uploaded here\)/)).toBeTruthy());

    fireEvent.click(within(dialog).getByRole("button", { name: "Upload 1 image" }));
    await waitFor(() => expect(screen.getByText("Uploaded the new profile picture and selected it.")).toBeTruthy());
    // An ordinary gallery image of this device...
    const [presign] = request.mock.calls.filter(([, path]) => path === "/artifacts/presign");
    expect(presign[2]!.body).toMatchObject({ deviceIds: [DEVICE_ID], files: [expect.objectContaining({ type: "image" })] });
    expect(onGalleryChanged).toHaveBeenCalled();
    // ...selected only after it was ready.
    expect(patches()).toEqual([{ profileImageArtifactId: NEW }]);
    expect(devicePicture()).toBe(NEW);
  });

  it("keeps an uploaded image whose selection failed, and lets the selection be retried", async () => {
    serve({ images: [image(FIRST, "Main board")], patchFailures: [new TypeError("Failed to fetch")] });
    render(<Harness initial={{ ...DEVICE, profileImageArtifactId: FIRST }} />);
    openMenuItem("Change: upload new picture");
    const dialog = screen.getByRole("dialog");
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
    Object.defineProperty(input, "files", { value: [new File([PNG], "new.png", { type: "image/png" })], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Upload 1 image" })).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload 1 image" }));

    await waitFor(() => expect(within(dialog).getByText(/uploaded and is in the gallery, but it couldn.t be set/)).toBeTruthy());
    expect(devicePicture()).toBe(FIRST); // unchanged
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(devicePicture()).toBe(NEW));
    // The image was uploaded once; only the selection was repeated.
    expect(request.mock.calls.filter(([, path]) => path === "/artifacts/presign")).toHaveLength(1);
    expect(patches()).toEqual([{ profileImageArtifactId: NEW }, { profileImageArtifactId: NEW }]);
  });

  it("changes nothing when the upload itself fails", async () => {
    serve({ images: [image(FIRST, "Main board")] });
    const routed = request.getMockImplementation()!;
    request.mockImplementation(async (method, path, options) => {
      if (path === "/artifacts/complete") {
        const { items } = options!.body as { items: { artifactId: string; attemptId: string }[] };
        return { results: items.map((i) => ({ artifactId: i.artifactId, ok: false, status: 422, error: "Uploaded file is not a valid image/png image" })) };
      }
      return routed(method, path, options);
    });
    const onGalleryChanged = vi.fn();
    render(<Harness initial={{ ...DEVICE, profileImageArtifactId: FIRST }} onGalleryChanged={onGalleryChanged} />);
    openMenuItem("Change: upload new picture");
    const dialog = screen.getByRole("dialog");
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
    Object.defineProperty(input, "files", { value: [new File([PNG], "new.png", { type: "image/png" })], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Upload 1 image" })).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload 1 image" }));
    await waitFor(() => expect(within(dialog).getAllByText(/Failed/).length).toBeGreaterThan(0));
    expect(patches()).toEqual([]);
    expect(onGalleryChanged).not.toHaveBeenCalled();
    expect(devicePicture()).toBe(FIRST);
  });

  it("replaces the picture's file and shows the new file without choosing it again", async () => {
    serve({ images: [image(FIRST, "Main board")] });
    render(<Harness initial={{ ...DEVICE, profileImageArtifactId: FIRST }} />);
    const avatar = () => screen.getByRole("img", { name: "Profile picture of Infusion pump" });
    await waitFor(() => expect(avatar().getAttribute("src")).toBe(`https://s3.example/${FIRST}?call=1`));

    openMenuItem("Replace picture file");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Replace image" })).toBeTruthy());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/permanently deletes the current file/)).toBeTruthy();
    const input = within(dialog).getByLabelText("New image file");
    Object.defineProperty(input, "files", { value: [new File([PNG], "hires.png", { type: "image/png" })], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(within(dialog).getByAltText("New file for Main board")).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace image" }));

    await waitFor(() => expect(screen.getByText(/Replaced the profile picture's file\./)).toBeTruthy());
    // Same artifact, so the device wasn't changed; its picture shows the new file.
    expect(patches()).toEqual([]);
    expect(devicePicture()).toBe(FIRST);
    await waitFor(() => expect(avatar().getAttribute("src")).toBe(`https://s3.example/${FIRST}?call=2`));
  });

  it("shows the default icon for a picture that is no longer available, and can still remove it", async () => {
    serve({ images: [], unavailable: new Set([FIRST]) });
    render(<Harness initial={{ ...DEVICE, profileImageArtifactId: FIRST }} />);
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Profile picture of Infusion pump (no picture)" })).toBeTruthy()
    );
    fireEvent.click(screen.getByRole("button", { name: "Profile picture options" }));
    // Its file can't be replaced, but it can be changed or removed.
    expect(screen.queryByRole("menuitem", { name: "Replace picture file" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove profile picture" }));
    await waitFor(() => expect(devicePicture()).toBe("none"));
  });
});
