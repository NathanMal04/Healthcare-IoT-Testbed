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

import { ApiError, apiRequest } from "@/lib/api";
import type { ImageArtifact } from "@/lib/images";
import EditImageDialog from "./EditImageDialog";

const request = vi.mocked(apiRequest);

function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function image(overrides: Partial<ImageArtifact> = {}): ImageArtifact {
  return {
    artifactId: "img-1", name: "board.png", type: "image", status: "ready", title: "Main board",
    description: "Top side", mimeType: "image/png", capturedAt: null, updatedAt: null, ...overrides,
  } as ImageArtifact;
}

function saved(body: Record<string, unknown>) {
  return { artifactId: "img-1", type: "image", status: "ready", title: "Main board", description: "Top side",
    mimeType: "image/png", capturedAt: null, updatedAt: "2026-11-01T00:00:00+00:00", ...body };
}

beforeEach(() => {
  request.mockReset();
});
afterEach(cleanup);

describe("EditImageDialog", () => {
  it("saves other fields when the stored capture date is one the form alone would reject", async () => {
    // The backend allows a day of time-zone slack, so "tomorrow" can be stored.
    const tomorrow = localDate(1);
    request.mockResolvedValueOnce(saved({ title: "UART header", capturedAt: tomorrow }));
    const onSaved = vi.fn();
    render(<EditImageDialog image={image({ capturedAt: tomorrow })} onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "UART header" } });
    expect(screen.queryByText(/can't be in the future/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith("PATCH", "/artifacts/img-1", { body: { title: "UART header" } });
    expect(onSaved.mock.calls[0][0]).toMatchObject({ title: "UART header", capturedAt: tomorrow, mimeType: "image/png" });
  });

  it("still checks a capture date the user changes", () => {
    render(<EditImageDialog image={image()} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Captured on/), { target: { value: localDate(2) } });
    expect(screen.getByText("Captured date can't be in the future")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a precise UTC capture time unless the date is changed, and says so", async () => {
    const precise = "2024-03-02T08:15:00+00:00";
    request.mockResolvedValueOnce(saved({ description: null, capturedAt: precise }));
    const onSaved = vi.fn();
    render(<EditImageDialog image={image({ capturedAt: precise })} onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.getByText(/saved with a time of day/)).toBeTruthy();
    // Clearing the description removes it (null); the capture time isn't sent.
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith("PATCH", "/artifacts/img-1", { body: { description: null } });
  });

  it("clears the capture date with null", async () => {
    request.mockResolvedValueOnce(saved({ capturedAt: null }));
    const onSaved = vi.fn();
    render(<EditImageDialog image={image({ capturedAt: "2024-03-02" })} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith("PATCH", "/artifacts/img-1", { body: { capturedAt: null } });
  });

  it("shows a server error and lets the user try again", async () => {
    request.mockRejectedValueOnce(new ApiError("Artifact not found", 404)).mockResolvedValueOnce(saved({ title: "New" }));
    const onSaved = vi.fn();
    render(<EditImageDialog image={image()} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByText(/no longer exists/)).toBeTruthy());
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("can't save an empty title", () => {
    render(<EditImageDialog image={image()} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  " } });
    expect(screen.getByText("Title can't be empty")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
