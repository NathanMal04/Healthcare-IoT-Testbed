import { describe, expect, it } from "vitest";
import { filterAndSortWorkspaces, personalMatches, summarizeWorkspaces } from "@/lib/workspaceGallery";
import type { Workspace, WorkspaceMember } from "@/lib/workspaces";

function workspace(name: string, role: Workspace["role"], createdAt: string, updatedAt = createdAt): Workspace {
  return { workspaceId: name, name, role, createdBy: "u1", createdAt, updatedAt };
}

function member(userId: string): WorkspaceMember {
  return { userId, role: "member", email: `${userId}@x.com`, joinedAt: null, invitedBy: null };
}

const list = [
  workspace("beta", "member", "2026-01-02", "2026-03-01"),
  workspace("Alpha", "owner", "2026-01-01", "2026-01-05"),
  workspace("gamma", "owner", "2026-01-03", "2026-02-01"),
];

describe("filterAndSortWorkspaces", () => {
  it("sorts by the chosen order", () => {
    expect(filterAndSortWorkspaces(list, "", "updated").map((w) => w.name)).toEqual(["beta", "gamma", "Alpha"]);
    expect(filterAndSortWorkspaces(list, "", "created").map((w) => w.name)).toEqual(["gamma", "beta", "Alpha"]);
    expect(filterAndSortWorkspaces(list, "", "name").map((w) => w.name)).toEqual(["Alpha", "beta", "gamma"]);
    expect(filterAndSortWorkspaces(list, "", "role").map((w) => w.name)).toEqual(["Alpha", "gamma", "beta"]);
  });

  it("filters by name, ignoring case, without changing the input", () => {
    expect(filterAndSortWorkspaces(list, " AL ", "name").map((w) => w.name)).toEqual(["Alpha"]);
    expect(list.map((w) => w.name)).toEqual(["beta", "Alpha", "gamma"]);
  });
});

describe("personalMatches", () => {
  it("matches an empty query or part of 'personal'", () => {
    expect(personalMatches("")).toBe(true);
    expect(personalMatches("Pers")).toBe(true);
    expect(personalMatches("lab")).toBe(false);
  });
});

describe("summarizeWorkspaces", () => {
  it("counts each member once and sums devices and CVEs", () => {
    const summary = summarizeWorkspaces([
      { members: [member("a"), member("b")], devices: 2, cves: 1 },
      { members: [member("b"), member("c")], devices: 3, cves: 0 },
    ]);
    expect(summary.members).toEqual({ value: 3, loading: false, incomplete: false });
    expect(summary.devices).toEqual({ value: 5, loading: false, incomplete: false });
    expect(summary.cves).toEqual({ value: 1, loading: false, incomplete: false });
  });

  it("reports loading and failed workspaces", () => {
    const summary = summarizeWorkspaces([
      { members: undefined, devices: null, cves: 4 },
      { members: [member("a")], devices: 1, cves: undefined },
    ]);
    expect(summary.members).toEqual({ value: 1, loading: true, incomplete: false });
    expect(summary.devices).toEqual({ value: 1, loading: false, incomplete: true });
    expect(summary.cves).toEqual({ value: 4, loading: true, incomplete: false });
  });

  it("is zero with no workspaces", () => {
    expect(summarizeWorkspaces([]).devices).toEqual({ value: 0, loading: false, incomplete: false });
  });
});
