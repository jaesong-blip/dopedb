// Workspace 정체성 fixture. 실제 계정·이메일·token·URL을 넣지 않는다.
// 이메일이 필요하면 example.invalid, id는 명백한 fixture 값만 사용한다.
import {
  accountId,
  workspaceId,
  type Workspace,
  type WorkspaceAuthState,
  type WorkspaceFeatureState,
} from "../../../src/features/workspaces/domain";

/** 최초 실행은 로컬 전용이다. cloud workspace 기능을 켜지 않는다. */
export const workspaceFeatureDisabled = {
  enabled: false,
} satisfies WorkspaceFeatureState;

export const localWorkspace = {
  id: workspaceId("fixture-workspace-0000-0000-0000-000000000001"),
  name: "Local",
  kind: "personal",
  lifecycleState: "active",
  createdAt: "2026-01-05T00:00:00.000Z",
  updatedAt: "2026-01-05T00:00:00.000Z",
} satisfies Workspace;

export const signedOutAuthState = {
  authenticated: false,
  user: null,
  accounts: [],
} satisfies WorkspaceAuthState;

export const signedInAuthState = {
  authenticated: true,
  user: {
    id: accountId("fixture-account-0000-0000-0000-000000000001"),
    email: "analyst@example.invalid",
    displayName: "Fixture Analyst",
  },
  accounts: [
    {
      user: {
        id: accountId("fixture-account-0000-0000-0000-000000000001"),
        email: "analyst@example.invalid",
        displayName: "Fixture Analyst",
      },
      memberships: [{ workspaceId: localWorkspace.id, role: "owner" }],
    },
  ],
} satisfies WorkspaceAuthState;
