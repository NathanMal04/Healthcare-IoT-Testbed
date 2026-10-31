import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/api pulls in Amplify; only apiRequest is needed, as a mock.
vi.mock("@/lib/api", () => ({ apiRequest: vi.fn() }));

import { apiRequest } from "@/lib/api";
import { parseRunSelection, serializeRunSelection, startRun, type RunRequest } from "@/lib/runs";
import { PERSONAL_SCOPE, scopeKey, scopeWorkspaceId, type Scope } from "@/lib/workspaces";

// Artifacts → "Run a script" → /runs?selection=1, as the two pages do it:
// the Artifacts page stores the ids under its scope, the run form reads them
// back under its own and sends its scope's workspaceId.

const request = vi.mocked(apiRequest);
const W1_ID = "0192b000-0000-7000-8000-000000000001";
const W1: Scope = { kind: "workspace", workspaceId: W1_ID, name: "Lab", role: "member" };
const W2: Scope = { kind: "workspace", workspaceId: "0192b000-0000-7000-8000-000000000002", name: "Other", role: "owner" };

/** What the Artifacts page stores, then what the run form picks up in `formScope`. */
function pickThenOpenForm(pickedIn: Scope, artifactIds: string[], formScope: Scope): string[] {
  return parseRunSelection(serializeRunSelection(scopeKey(pickedIn), artifactIds), scopeKey(formScope));
}

/** The run form's request for a selection, as NewRunForm builds it. */
function selectionRequest(scope: Scope, selection: string[]): RunRequest {
  const workspaceId = scopeWorkspaceId(scope);
  return {
    moduleId: "11111111-1111-4111-8111-111111111111",
    inputs: { artifactIds: selection },
    mode: "map",
    class: "economy",
    size: "S",
    timeoutMinutes: 30,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({ run: { runId: "r" } });
});

describe("Artifacts → Run a script", () => {
  it("preselects a Personal artifact and starts a Personal run", async () => {
    const selection = pickThenOpenForm(PERSONAL_SCOPE, ["a1"], PERSONAL_SCOPE);
    expect(selection).toEqual(["a1"]);
    await startRun(selectionRequest(PERSONAL_SCOPE, selection));
    const body = request.mock.calls[0][2]?.body as RunRequest;
    expect(body.inputs).toEqual({ artifactIds: ["a1"] });
    expect(body).not.toHaveProperty("workspaceId");
  });

  it("preselects a workspace artifact and sends the workspace's id", async () => {
    const selection = pickThenOpenForm(W1, ["a1", "a2"], W1);
    expect(selection).toEqual(["a1", "a2"]);
    await startRun(selectionRequest(W1, selection));
    expect(request).toHaveBeenCalledWith("POST", "/runs", {
      body: expect.objectContaining({ inputs: { artifactIds: ["a1", "a2"] }, workspaceId: W1_ID }),
    });
  });

  it("drops a selection picked in another scope", () => {
    expect(pickThenOpenForm(W1, ["a1"], PERSONAL_SCOPE)).toEqual([]);
    expect(pickThenOpenForm(PERSONAL_SCOPE, ["a1"], W1)).toEqual([]);
    expect(pickThenOpenForm(W1, ["a1"], W2)).toEqual([]);
  });

  it("drops the selection when the workspace is switched before the form opens", () => {
    const stored = serializeRunSelection(scopeKey(W1), ["a1"]);
    expect(parseRunSelection(stored, scopeKey(W2))).toEqual([]);
    // Switching back finds it again; it was never applied to W2.
    expect(parseRunSelection(stored, scopeKey(W1))).toEqual(["a1"]);
  });
});

describe("no Personal-only run restriction is left", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const LEGACY = [/Workspace analysis runs are not available/i, /runsAvailable/];

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
    });
  }

  it("has no legacy warning or gate in the app", () => {
    const offenders = ["app", "lib", "context"]
      .flatMap((dir) => sources(join(root, dir)))
      .filter((file) => LEGACY.some((pattern) => pattern.test(readFileSync(file, "utf8"))));
    expect(offenders).toEqual([]);
  });
});

describe("deploy cache headers", () => {
  // Client-side navigation (router.push from Artifacts to /runs) fetches
  // /runs.txt?_rsc=<hash of router state>. That URL is the same across
  // builds, so if it is cached as immutable the browser keeps rendering the
  // old page after a deploy.
  const workflow = readFileSync(fileURLToPath(new URL("../../../../.github/workflows/deploy-web.yml", import.meta.url)), "utf8");
  const syncs = workflow.split("aws s3 sync").slice(1);

  it("never marks pages or their RSC payloads immutable", () => {
    const immutable = syncs.filter((s) => s.includes("immutable"));
    expect(immutable).toHaveLength(1);
    expect(immutable[0]).toContain('--exclude "*.html"');
    expect(immutable[0]).toContain('--exclude "*.txt"');
  });

  it("uploads pages and RSC payloads as no-cache", () => {
    const noCache = syncs.find((s) => s.includes('"no-cache"'));
    expect(noCache).toContain('--include "*.html"');
    expect(noCache).toContain('--include "*.txt"');
  });
});
