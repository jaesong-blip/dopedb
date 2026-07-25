// Account/workspace selector projection tests cover duplicate memberships and the
// composite values used to switch both identity and workspace atomically.
import { describe, expect, it } from "vitest";
import {
  accountId,
  workspaceId,
  type Workspace,
  type WorkspaceAuthState,
} from "./domain";
import {
  buildWorkspaceChoiceGroups,
  canManageWorkspaceConnections,
  parseWorkspaceChoice,
  workspaceChoiceValue,
} from "./choices";

const personal: Workspace = {
  id: workspaceId("00000000-0000-0000-0000-000000000001"),
  name: "Personal Workspace",
  kind: "personal",
  lifecycleState: "active",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const team: Workspace = {
  ...personal,
  id: workspaceId("team-1"),
  name: "Team",
  kind: "team",
};

describe("workspace account choices", () => {
  it("groups the same workspace under every account that can access it", () => {
    const auth: WorkspaceAuthState = {
      authenticated: true,
      user: { id: accountId("account-a"), email: "a@example.com", displayName: "A" },
      accounts: [
        {
          user: { id: accountId("account-a"), email: "a@example.com", displayName: "A" },
          memberships: [{ workspaceId: team.id, role: "owner" }],
        },
        {
          user: { id: accountId("account-b"), email: "b@example.com", displayName: "B" },
          memberships: [{ workspaceId: team.id, role: "viewer" }],
        },
      ],
    };

    const groups = buildWorkspaceChoiceGroups(auth, [personal, team], "Local");
    expect(groups.map((group) => group.key)).toEqual(["local", "account-a", "account-b"]);
    expect(groups[1].choices[0].value).toBe("account-a:team-1");
    expect(groups[2].choices[0].role).toBe("viewer");
  });

  it("round-trips local and hosted selections", () => {
    expect(parseWorkspaceChoice(workspaceChoiceValue(personal.id, null))).toEqual({
      workspaceId: personal.id,
      accountUserId: null,
    });
    expect(parseWorkspaceChoice("account-a:team-1")).toEqual({
      workspaceId: workspaceId("team-1"),
      accountUserId: accountId("account-a"),
    });
    expect(parseWorkspaceChoice("invalid")).toBeNull();
  });

  it("limits shared-template management to administrators and owners", () => {
    expect(canManageWorkspaceConnections("owner")).toBe(true);
    expect(canManageWorkspaceConnections("admin")).toBe(true);
    expect(canManageWorkspaceConnections("editor")).toBe(false);
    expect(canManageWorkspaceConnections("analyst")).toBe(false);
    expect(canManageWorkspaceConnections("viewer")).toBe(false);
    expect(canManageWorkspaceConnections(null)).toBe(false);
  });
});
