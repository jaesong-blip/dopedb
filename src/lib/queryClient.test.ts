import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  accountId,
  type WorkspaceAuthState,
} from "../features/workspaces/domain";
import { replaceWorkspaceAuth } from "../features/workspaces/cache";
import { workspaceQueryKeys } from "../features/workspaces/queries";
import { resetWorkspaceResourceQueries } from "./queryClient";
import { qk } from "./queries";

describe("workspace query lifecycle", () => {
  it("clears workspace data without dropping signed-in identity or global data", async () => {
    const client = new QueryClient();
    const auth: WorkspaceAuthState = {
      authenticated: true,
      user: {
        id: accountId("user-1"),
        email: "user@example.com",
        displayName: "User",
      },
      accounts: [],
    };
    replaceWorkspaceAuth(client, auth);
    client.setQueryData(qk.catalog("connection-1"), { tables: [] });
    client.setQueryData(qk.chatThreads(), [{ id: "thread-1" }]);
    client.setQueryData(qk.chatMessages("thread-1"), [{ id: "message-1" }]);
    client.setQueryData(qk.drivers(), [{ id: "bundled" }]);
    client.setQueryData(qk.legacyMcpCleanup(), { targets: [] });

    await resetWorkspaceResourceQueries(client);

    expect(client.getQueryData(workspaceQueryKeys.auth())).toEqual(auth);
    expect(client.getQueryData(qk.catalog("connection-1"))).toBeUndefined();
    expect(client.getQueryData(qk.chatThreads())).toBeUndefined();
    expect(client.getQueryData(qk.chatMessages("thread-1"))).toBeUndefined();
    expect(client.getQueryData(qk.drivers())).toEqual([{ id: "bundled" }]);
    expect(client.getQueryData(qk.legacyMcpCleanup())).toEqual({ targets: [] });
  });
});
