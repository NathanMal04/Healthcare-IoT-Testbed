// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ ApiError: class extends Error {}, apiRequest: vi.fn() }));

import { apiRequest } from "@/lib/api";
import type { ImageArtifact } from "@/lib/images";
import { useDeviceImages } from "./useImageData";

// Paging races in useDeviceImages: every listing request is held until the
// test resolves it, so the order of overlapping loads is under control.

const request = vi.mocked(apiRequest);
const DEVICE = "11111111-1111-4111-8111-111111111111";

function image(id: string): ImageArtifact {
  return { artifactId: id, name: id, type: "image", status: "ready", title: id } as ImageArtifact;
}

type Page = { artifacts: ImageArtifact[]; nextToken?: string };
let pending: { token: unknown; resolve: (page: Page) => void; reject: (err: Error) => void }[];

beforeEach(() => {
  pending = [];
  request.mockReset();
  request.mockImplementation(
    (_method: string, _path: string, options?: { query?: Record<string, unknown> }) =>
      new Promise((resolve, reject) => pending.push({ token: options?.query?.nextToken, resolve, reject })) as never
  );
});
afterEach(cleanup);

const ids = (images: ImageArtifact[] | null) => images?.map((i) => i.artifactId);

async function loaded(first: Page) {
  const hook = renderHook(() => useDeviceImages(DEVICE));
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => pending.shift()!.resolve(first));
  return hook;
}

describe("useDeviceImages paging", () => {
  it("doesn't let Load more overtake a reload (the refresh after an upload is kept)", async () => {
    const { result } = await loaded({ artifacts: [image("a")], nextToken: "p2" });
    let reload!: Promise<void>;
    act(() => {
      reload = result.current.reload();
    });
    let added: boolean | undefined;
    await act(async () => {
      added = await result.current.loadMore();
    });
    expect(added).toBe(false);
    // No listing request was made for the Load more.
    expect(pending.map((p) => p.token)).toEqual([undefined]);
    await act(async () => {
      pending.shift()!.resolve({ artifacts: [image("new"), image("a")], nextToken: "p2b" });
      await reload;
    });
    expect(ids(result.current.images)).toEqual(["new", "a"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.hasMore).toBe(true);
  });

  it("makes no request, and cancels nothing, when there is no next page", async () => {
    const { result } = await loaded({ artifacts: [image("a")] });
    let reload!: Promise<void>;
    act(() => {
      reload = result.current.reload();
    });
    await act(async () => {
      expect(await result.current.loadMore()).toBe(false);
    });
    await act(async () => {
      pending.shift()!.resolve({ artifacts: [image("b"), image("a")] });
      await reload;
    });
    // The reload's result was applied and loading ended.
    expect(ids(result.current.images)).toEqual(["b", "a"]);
    expect(result.current.loading).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("runs one Load more at a time", async () => {
    const { result } = await loaded({ artifacts: [image("a")], nextToken: "p2" });
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.loadMore();
      second = result.current.loadMore();
    });
    expect(await second).toBe(false);
    expect(pending.map((p) => p.token)).toEqual(["p2"]);
    await act(async () => {
      pending.shift()!.resolve({ artifacts: [image("b")] });
    });
    expect(await first).toBe(true);
    expect(ids(result.current.images)).toEqual(["a", "b"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("lets a reload overtake a running Load more", async () => {
    const { result } = await loaded({ artifacts: [image("a")], nextToken: "p2" });
    let more!: Promise<boolean>;
    let reload!: Promise<void>;
    act(() => {
      more = result.current.loadMore();
    });
    act(() => {
      reload = result.current.reload();
    });
    const [morePage, reloadPage] = pending;
    expect([morePage.token, reloadPage.token]).toEqual(["p2", undefined]);
    await act(async () => {
      reloadPage.resolve({ artifacts: [image("new"), image("a")], nextToken: "p2b" });
      await reload;
    });
    await act(async () => {
      morePage.resolve({ artifacts: [image("old-page-2")] });
    });
    // The stale page 2 of the old listing is dropped.
    expect(await more).toBe(false);
    expect(ids(result.current.images)).toEqual(["new", "a"]);
    expect(result.current.loading).toBe(false);
  });

  it("reports a failed page and allows trying again", async () => {
    const { result } = await loaded({ artifacts: [image("a")], nextToken: "p2" });
    let more!: Promise<boolean>;
    act(() => {
      more = result.current.loadMore();
    });
    await act(async () => {
      pending.shift()!.reject(new Error("Network down"));
    });
    expect(await more).toBe(false);
    expect(result.current.error).toBe("Network down");
    expect(ids(result.current.images)).toEqual(["a"]);
    act(() => {
      more = result.current.loadMore();
    });
    expect(pending.map((p) => p.token)).toEqual(["p2"]);
  });
});
