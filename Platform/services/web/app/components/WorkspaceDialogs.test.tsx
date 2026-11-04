// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { userId: "owner-1" }, loading: false }) }));
const workspaceContext = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/context/WorkspaceContext", () => ({ useWorkspace: () => workspaceContext.value }));
vi.mock("@/lib/api", () => ({ ApiError: class extends Error {}, apiRequest: vi.fn() }));

import { InvitationsList, MembersPanel, RoleBadge } from "./WorkspaceDialogs";
import type { InviteRole, WorkspaceDetail, WorkspaceInvite } from "@/lib/workspaces";

afterEach(cleanup);

const W = "0192b000-0000-7000-8000-000000000001";

function detail(role: "owner" | "member" | "viewer"): WorkspaceDetail {
  return {
    workspace: { workspaceId: W, name: "Senior Design", role, createdBy: "owner-1", createdAt: "2026-10-01", updatedAt: "2026-10-01" },
    members: [
      { userId: "owner-1", role: "owner", email: "ipule@example.com", joinedAt: "2026-10-01", invitedBy: null },
      { userId: "member-1", role: "member", email: "justin@example.com", joinedAt: "2026-10-02", invitedBy: "owner-1" },
      { userId: "viewer-1", role: "viewer", email: "prof@university.edu", joinedAt: "2026-10-03", invitedBy: "owner-1" },
    ],
    ...(role === "owner"
      ? {
          invites: [
            {
              email: "advisor@university.edu", role: "viewer" as const, invitedBy: "owner-1",
              invitedByEmail: "ipule@example.com", createdAt: "2026-10-04", expiresAt: "2026-10-18",
            },
          ],
        }
      : {}),
  };
}

function renderPanel(role: "owner" | "member" | "viewer") {
  const handlers = {
    onInvite: vi.fn(
      async (email: string, inviteRole: InviteRole): Promise<WorkspaceInvite> => ({
        email, role: inviteRole, invitedBy: "owner-1", invitedByEmail: null, createdAt: "", expiresAt: "",
      })
    ),
    onRevoke: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
  };
  render(<MembersPanel detail={detail(role)} currentUserId={role === "owner" ? "owner-1" : "viewer-1"} {...handlers} />);
  return handlers;
}

describe("RoleBadge", () => {
  it("labels each role", () => {
    render(
      <>
        <RoleBadge role="owner" />
        <RoleBadge role="member" />
        <RoleBadge role="viewer" />
      </>
    );
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText("Member")).toBeTruthy();
    expect(screen.getByText("Viewer")).toBeTruthy();
  });
});

describe("MembersPanel for an owner", () => {
  it("invites a viewer", async () => {
    const { onInvite } = renderPanel("owner");
    fireEvent.change(screen.getByLabelText("Email address to invite"), { target: { value: " prof2@university.edu " } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "viewer" } });
    expect(screen.getByText(/can browse and download everything/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Invite viewer" }));
    await waitFor(() => expect(onInvite).toHaveBeenCalledWith("prof2@university.edu", "viewer"));
    expect(await screen.findByText(/Viewer invitation created for prof2@university.edu/)).toBeTruthy();
  });

  it("invites a member by default", async () => {
    const { onInvite } = renderPanel("owner");
    fireEvent.change(screen.getByLabelText("Email address to invite"), { target: { value: "s@university.edu" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite member" }));
    await waitFor(() => expect(onInvite).toHaveBeenCalledWith("s@university.edu", "member"));
  });

  it("removes a viewer after confirming, but never offers to remove an owner or themselves", async () => {
    const { onRemove } = renderPanel("owner");
    expect(screen.queryByRole("button", { name: /Remove ipule@example.com/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove justin@example.com from the workspace" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove prof@university.edu from the workspace" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove access" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("viewer-1"));
  });

  it("shows a pending invitation's role and revokes it after confirming", async () => {
    const { onRevoke } = renderPanel("owner");
    const pending = screen.getByText("advisor@university.edu").closest("tr")!;
    expect(within(pending).getByText("Viewer")).toBeTruthy();
    fireEvent.click(within(pending).getByRole("button", { name: "Revoke the invitation for advisor@university.edu" }));
    fireEvent.click(within(pending).getByRole("button", { name: "Revoke invitation" }));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledWith("advisor@university.edu"));
  });

  it("shows why a removal failed", async () => {
    const { onRemove } = renderPanel("owner");
    onRemove.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(screen.getByRole("button", { name: "Remove prof@university.edu from the workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove access" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't remove/);
  });
});

describe("MembersPanel for a viewer or member", () => {
  it.each(["viewer", "member"] as const)("a %s sees members with their roles, and no management controls", (role) => {
    renderPanel(role);
    const viewerRow = screen.getByText("prof@university.edu").closest("tr")!;
    expect(within(viewerRow).getByText("Viewer")).toBeTruthy();
    expect(screen.queryByLabelText("Email address to invite")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(screen.queryByText("advisor@university.edu")).toBeNull();
    expect(screen.getByText("Only workspace owners can invite members.")).toBeTruthy();
  });
});

describe("InvitationsList", () => {
  it("says which role an invitation grants", async () => {
    workspaceContext.value = {
      invitations: [
        { workspaceId: W, workspaceName: "Senior Design", role: "viewer", invitedBy: "owner-1",
          invitedByEmail: "ipule@example.com", createdAt: "2026-10-04", expiresAt: "2026-10-18" },
        { workspaceId: "w2", workspaceName: "Lab", role: "member", invitedBy: "owner-1",
          invitedByEmail: null, createdAt: "2026-10-04", expiresAt: "2026-10-18" },
      ],
      invitationsError: null,
      refreshInvitations: vi.fn(async () => undefined),
      refreshWorkspaces: vi.fn(async () => undefined),
      selectWorkspace: vi.fn(),
      scopeLocked: false,
    };
    render(<InvitationsList />);
    expect(screen.getByText("as a viewer (read-only)")).toBeTruthy();
    expect(screen.getByText("as a member")).toBeTruthy();
  });
});
