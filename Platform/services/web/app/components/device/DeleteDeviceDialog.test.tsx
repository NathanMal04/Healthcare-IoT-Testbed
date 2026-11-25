// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const locks = vi.hoisted(() => [] as boolean[]);
vi.mock("@/context/WorkspaceContext", () => ({ useScopeLock: (active: boolean) => locks.push(active) }));
vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    status: number;
    details: Record<string, unknown>;
    constructor(message: string, status: number, details: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  return { ApiError, apiRequest: vi.fn() };
});
const api = vi.hoisted(() => ({ preview: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/devices")>()),
  getDeviceDeletionPreview: api.preview,
  deleteDevice: api.remove,
}));

import { ApiError } from "@/lib/api";
import type { Device, DeviceDeletionPreview } from "@/lib/devices";
import type { Scope } from "@/lib/workspaces";
import { axeViolations } from "@/app/components/ui/testing/axe";
import DeleteDeviceDialog from "./DeleteDeviceDialog";

afterEach(cleanup);

const NAME = "ALFA AWUS036ACH";
const DEVICE: Device = {
  deviceId: "11111111-1111-4111-8111-0000000000a1", name: NAME, type: "wifi-adapter", role: "owner",
  reverseEngineeringStatus: "in_progress", workspaceId: "ws-1", canDelete: true,
};
const SCOPE = { kind: "workspace", workspaceId: "ws-1", name: "Senior Design", role: "owner" } as unknown as Scope;
const PREVIEW: DeviceDeletionPreview = {
  deviceId: DEVICE.deviceId, name: NAME, workspaceId: "ws-1",
  resources: {
    firmware: 2, images: 3, otherArtifacts: 0, sharedArtifacts: 1, cves: 2, runs: 0, notebookSections: 1, notebookEntries: 4,
  },
};

function renderDialog() {
  const onCancel = vi.fn();
  const onDeleted = vi.fn();
  const view = render(<DeleteDeviceDialog device={DEVICE} scope={SCOPE} onCancel={onCancel} onDeleted={onDeleted} />);
  return { onCancel, onDeleted, view };
}

const confirmInput = () => screen.getByLabelText(/to confirm/) as HTMLInputElement;
const deleteButton = () => screen.getByRole("button", { name: "Delete device" }) as HTMLButtonElement;

beforeEach(() => {
  api.preview.mockReset().mockResolvedValue(PREVIEW);
  api.remove.mockReset().mockResolvedValue({ deviceId: DEVICE.deviceId, deleted: true, cleanupPending: false });
  locks.length = 0;
});

describe("DeleteDeviceDialog", () => {
  it("shows the device name, scope and what is deleted or kept", async () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: `Delete ${NAME}?` })).toBeTruthy();
    expect(screen.getByText(/Checking what this device contains/)).toBeTruthy();
    await screen.findByTestId("deletion-summary");
    expect(api.preview).toHaveBeenCalledWith(DEVICE.deviceId);
    expect(screen.getByText(/the Senior Design workspace/)).toBeTruthy();
    for (const line of [
      "2 firmware files", "3 images", "The RE Notebook: 1 section, 4 entries",
      "2 CVE links (the CVE records stay)", "1 file also used by other devices or runs (unlinked, not deleted)",
    ]) {
      expect(screen.getByText(line)).toBeTruthy();
    }
  });

  it("enables delete only once the exact name is typed", async () => {
    renderDialog();
    await screen.findByTestId("deletion-summary");
    expect(deleteButton().disabled).toBe(true);
    fireEvent.change(confirmInput(), { target: { value: "alfa awus036ach" } });
    expect(deleteButton().disabled).toBe(true);
    expect(screen.getByText("That doesn't match the device's name yet.")).toBeTruthy();
    fireEvent.submit(confirmInput().form!);
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.change(confirmInput(), { target: { value: `${NAME} ` } });
    expect(deleteButton().disabled).toBe(false);
  });

  it("deletes, shows progress and holds the workspace while it runs", async () => {
    let finish: (value: unknown) => void = () => {};
    api.remove.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { onDeleted, onCancel } = renderDialog();
    await screen.findByTestId("deletion-summary");
    fireEvent.change(confirmInput(), { target: { value: NAME } });
    fireEvent.click(deleteButton());
    expect(api.remove).toHaveBeenCalledWith(DEVICE.deviceId, NAME);
    expect(await screen.findByRole("button", { name: "Deleting…" })).toBeTruthy();
    expect(screen.getByText(/Keep this page open/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(locks).toContain(true);
    // Escape and Close are ignored while deleting.
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onCancel).not.toHaveBeenCalled();
    finish({ deviceId: DEVICE.deviceId, deleted: true, cleanupPending: true });
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ cleanupPending: true }));
  });

  it("explains a failure and lets the user try again", async () => {
    api.remove.mockRejectedValueOnce(new ApiError("Internal server error", 500));
    const { onDeleted } = renderDialog();
    await screen.findByTestId("deletion-summary");
    fireEvent.change(confirmInput(), { target: { value: NAME } });
    fireEvent.click(deleteButton());
    expect(await screen.findByText("Internal server error")).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(deleteButton().disabled).toBe(false);
    fireEvent.click(deleteButton());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ cleanupPending: false }));
  });

  it("asks again when the device changed meanwhile", async () => {
    api.remove.mockRejectedValueOnce(new ApiError("changed", 409));
    renderDialog();
    await screen.findByTestId("deletion-summary");
    fireEvent.change(confirmInput(), { target: { value: NAME } });
    fireEvent.click(deleteButton());
    expect(await screen.findByText(/changed while you were deleting it/)).toBeTruthy();
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    expect(confirmInput().value).toBe("");
  });

  it("reports a refused deletion", async () => {
    api.remove.mockRejectedValueOnce(new ApiError("Viewers can't delete devices", 403));
    renderDialog();
    await screen.findByTestId("deletion-summary");
    fireEvent.change(confirmInput(), { target: { value: NAME } });
    fireEvent.click(deleteButton());
    expect(await screen.findByText("You don't have permission to delete this device.")).toBeTruthy();
  });

  it("treats a device that is already gone as deleted", async () => {
    api.remove.mockRejectedValueOnce(new ApiError("Device not found", 404));
    const { onDeleted } = renderDialog();
    await screen.findByTestId("deletion-summary");
    fireEvent.change(confirmInput(), { target: { value: NAME } });
    fireEvent.click(deleteButton());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ cleanupPending: false, alreadyGone: true }));
  });

  it("keeps delete disabled when the preview can't load, with a retry", async () => {
    api.preview.mockRejectedValueOnce(new ApiError("Not allowed", 403));
    renderDialog();
    expect(await screen.findByText(/You don't have permission to delete this device/)).toBeTruthy();
    expect(deleteButton().disabled).toBe(true);
    expect(confirmInput().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("deletion-summary");
    expect(confirmInput().disabled).toBe(false);
  });

  it("cancels", async () => {
    const { onCancel } = renderDialog();
    await screen.findByTestId("deletion-summary");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("has no accessibility violations", async () => {
    const { view } = renderDialog();
    await screen.findByTestId("deletion-summary");
    expect(await axeViolations(view.container)).toEqual([]);
  });
});
