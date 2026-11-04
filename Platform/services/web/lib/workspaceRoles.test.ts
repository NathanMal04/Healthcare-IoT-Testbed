import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ ApiError: class extends Error {}, apiRequest: vi.fn(async () => ({ invite: {} })) }));

import { apiRequest } from "@/lib/api";
import {
  canContribute,
  inviteWorkspaceMember,
  isReadOnlyScope,
  removeWorkspaceMember,
  revokeWorkspaceInvite,
  type Scope,
} from "@/lib/workspaces";

const W = "0192b000-0000-7000-8000-000000000001";
const ws = (role: string): Scope => ({ kind: "workspace", workspaceId: W, name: "Lab", role } as Scope);

describe("canContribute", () => {
  it("is true in Personal and for owners and members", () => {
    expect(canContribute({ kind: "personal" })).toBe(true);
    expect(canContribute(ws("owner"))).toBe(true);
    expect(canContribute(ws("member"))).toBe(true);
  });

  it("is false for viewers and for any role this client doesn't know", () => {
    expect(canContribute(ws("viewer"))).toBe(false);
    expect(isReadOnlyScope(ws("viewer"))).toBe(true);
    expect(canContribute(ws("auditor"))).toBe(false);
    expect(isReadOnlyScope({ kind: "personal" })).toBe(false);
  });
});

describe("workspace membership requests", () => {
  const request = vi.mocked(apiRequest);
  beforeEach(() => request.mockClear());

  it("sends the chosen role with an invitation, member by default", async () => {
    await inviteWorkspaceMember(W, "prof@university.edu", "viewer");
    await inviteWorkspaceMember(W, "student@university.edu");
    expect(request.mock.calls).toEqual([
      ["POST", `/workspaces/${W}/invites`, { body: { email: "prof@university.edu", role: "viewer" } }],
      ["POST", `/workspaces/${W}/invites`, { body: { email: "student@university.edu", role: "member" } }],
    ]);
  });

  it("revokes an invitation and removes a member", async () => {
    await revokeWorkspaceInvite(W, "prof@university.edu");
    await removeWorkspaceMember(W, "user/sub");
    expect(request.mock.calls).toEqual([
      ["POST", `/workspaces/${W}/invites/revoke`, { body: { email: "prof@university.edu" } }],
      ["DELETE", `/workspaces/${W}/members/user%2Fsub`],
    ]);
  });
});
