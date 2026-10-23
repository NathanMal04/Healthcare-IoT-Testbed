import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/api pulls in Amplify; only apiRequest is needed, as a mock.
vi.mock("@/lib/api", () => ({ apiRequest: vi.fn() }));

import { apiRequest } from "@/lib/api";
import { listUploadBatches } from "@/lib/artifacts";
import {
  estimateRun,
  listRuns,
  parseRunSelection,
  runInScope,
  serializeRunSelection,
  startRun,
  type RunRequest,
} from "@/lib/runs";

const request = vi.mocked(apiRequest);
const W1 = "0192b000-0000-7000-8000-000000000001";

const RUN: RunRequest = {
  moduleId: "11111111-1111-4111-8111-111111111111",
  inputs: { artifactIds: ["a"] },
  mode: "map",
  class: "economy",
  size: "S",
  timeoutMinutes: 30,
};

beforeEach(() => {
  request.mockReset();
});

describe("scoped run API calls", () => {
  it("lists personal runs without a workspaceId", async () => {
    request.mockResolvedValue({ runs: [] });
    await listRuns();
    expect(request).toHaveBeenCalledWith("GET", "/runs", { query: { workspaceId: undefined } });
  });

  it("lists a workspace's runs", async () => {
    request.mockResolvedValue({ runs: [{ runId: "r" }] });
    expect(await listRuns(W1)).toEqual([{ runId: "r" }]);
    expect(request).toHaveBeenCalledWith("GET", "/runs", { query: { workspaceId: W1 } });
  });

  it("lists personal or workspace upload batches", async () => {
    request.mockResolvedValue({ batches: [] });
    await listUploadBatches();
    await listUploadBatches(W1);
    expect(request.mock.calls).toEqual([
      ["GET", "/artifacts/batches", { query: { workspaceId: undefined } }],
      ["GET", "/artifacts/batches", { query: { workspaceId: W1 } }],
    ]);
  });

  it("sends the request body as given, with or without a workspace", async () => {
    request.mockResolvedValue({ run: { runId: "r" } });
    await startRun(RUN);
    await startRun({ ...RUN, workspaceId: W1 });
    await estimateRun({ ...RUN, workspaceId: W1 });
    expect(request.mock.calls).toEqual([
      ["POST", "/runs", { body: RUN }],
      ["POST", "/runs", { body: { ...RUN, workspaceId: W1 } }],
      ["POST", "/runs/estimate", { body: { ...RUN, workspaceId: W1 } }],
    ]);
  });
});

describe("runInScope", () => {
  it("matches personal runs to Personal only", () => {
    expect(runInScope({}, undefined)).toBe(true);
    expect(runInScope({}, W1)).toBe(false);
  });

  it("matches workspace runs to their own workspace only", () => {
    expect(runInScope({ workspaceId: W1 }, W1)).toBe(true);
    expect(runInScope({ workspaceId: W1 }, undefined)).toBe(false);
    expect(runInScope({ workspaceId: W1 }, "0192b000-0000-7000-8000-000000000002")).toBe(false);
  });
});

describe("run selection", () => {
  const workspace = `workspace:${W1}`;

  it("round-trips in the scope it was picked in", () => {
    expect(parseRunSelection(serializeRunSelection(workspace, ["a", "b"]), workspace)).toEqual(["a", "b"]);
    expect(parseRunSelection(serializeRunSelection("personal", ["c"]), "personal")).toEqual(["c"]);
  });

  it("is dropped after switching between Personal and a workspace", () => {
    expect(parseRunSelection(serializeRunSelection("personal", ["a"]), workspace)).toEqual([]);
    expect(parseRunSelection(serializeRunSelection(workspace, ["a"]), "personal")).toEqual([]);
    expect(parseRunSelection(serializeRunSelection(workspace, ["a"]), "workspace:other")).toEqual([]);
  });

  it("ignores missing, malformed and old unscoped selections", () => {
    expect(parseRunSelection(null, "personal")).toEqual([]);
    expect(parseRunSelection("not json", "personal")).toEqual([]);
    expect(parseRunSelection(JSON.stringify(["a"]), "personal")).toEqual([]);
    expect(parseRunSelection(JSON.stringify({ scope: "personal", artifactIds: "a" }), "personal")).toEqual([]);
    expect(parseRunSelection(JSON.stringify({ scope: "personal", artifactIds: ["a", 3] }), "personal")).toEqual(["a"]);
  });
});
