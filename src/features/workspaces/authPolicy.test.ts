import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import capability from "../../../src-tauri/capabilities/default.json";
import {
  cancelWorkspaceResourceQueries,
  resetConnectionResourceQueries,
  refetchWorkspaceResourceQueries,
  resetWorkspaceResourceQueries,
} from "../../lib/queryClient";
import {
  shouldRevalidateWorkspaceAuth,
  WORKSPACE_AUTH_RECHECK_MS,
} from "./authPolicy";
import {
  runWorkspaceAuthorityTransition,
  workspaceAuthorityChanged,
  workspaceResourceQueryScopeChanged,
} from "./cache";
import {
  accountId,
  workspaceId,
  type WorkspaceAuthState,
  type WorkspaceRole,
} from "./domain";
import type { WorkspaceContextState } from "./queries";

function authState(
  userId: string,
  membership?: { workspace: string; role: WorkspaceRole },
): WorkspaceAuthState {
  const user = {
    id: accountId(userId),
    email: `${userId}@example.test`,
    displayName: userId,
  };
  return {
    authenticated: true,
    user,
    authorityGeneration: 1,
    accounts: [{
      user,
      memberships: membership
        ? [{ workspaceId: workspaceId(membership.workspace), role: membership.role }]
        : [],
    }],
  };
}

function workspaceContext(id: string): WorkspaceContextState {
  const now = "2026-08-13T00:00:00Z";
  const active = {
    id: workspaceId(id),
    name: id,
    kind: "team" as const,
    lifecycleState: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  return { feature: { enabled: true }, workspaces: [active], active };
}

describe("workspace auth lifecycle", () => {
  it("keeps a recently verified signed-in state stable", () => {
    const recentlyVerifiedFocusMayRefreshAuthority = shouldRevalidateWorkspaceAuth(
      true,
      1_000,
      false,
      1_000 + 60_000,
    );
    // WorkspaceAccount uses this exact gate before the native membership/auth
    // refresh, whose authority fence would otherwise stop active ACP and PTY work.
    expect(recentlyVerifiedFocusMayRefreshAuthority).toBe(false);
  });

  it("revalidates a signed-in state after the cooldown", () => {
    expect(
      shouldRevalidateWorkspaceAuth(
        true,
        1_000,
        false,
        1_000 + WORKSPACE_AUTH_RECHECK_MS,
      ),
    ).toBe(true);
  });

  it("deduplicates checks, clears private observers, and restricts auth URLs", async () => {
    expect(shouldRevalidateWorkspaceAuth(true, 0, true, WORKSPACE_AUTH_RECHECK_MS)).toBe(false);
    expect(shouldRevalidateWorkspaceAuth(false, 0, false, WORKSPACE_AUTH_RECHECK_MS)).toBe(false);

    const opener = capability.permissions.find((permission) => (
      typeof permission !== "string" && permission.identifier === "opener:allow-open-url"
    ));
    const allowedUrls = typeof opener === "string"
      ? []
      : opener?.allow?.flatMap((entry) => entry.url ?? []) ?? [];
    expect(allowedUrls).toContain(
      "https://github.com/apps/dopedb-knowledge/installations/new?state=*",
    );
    expect(allowedUrls).not.toContain("https://github.com/*");

    const accountA = authState("account-a");
    const workspaceA = workspaceContext("workspace-a");
    expect(
      workspaceAuthorityChanged(accountA, workspaceA, accountA, workspaceA),
    ).toBe(false);
    expect(
      workspaceAuthorityChanged(
        accountA,
        workspaceA,
        authState("account-b"),
        workspaceA,
      ),
    ).toBe(true);
    expect(
      workspaceAuthorityChanged(
        accountA,
        workspaceA,
        accountA,
        workspaceContext("workspace-b"),
      ),
    ).toBe(true);
    const roleBefore = authState(
      "account-a",
      { workspace: "workspace-a", role: "admin" },
    );
    const roleAfter = authState(
      "account-a",
      { workspace: "workspace-a", role: "viewer" },
    );
    expect(
      workspaceAuthorityChanged(
        roleBefore,
        workspaceA,
        roleAfter,
        workspaceA,
      ),
    ).toBe(true);
    expect(
      workspaceResourceQueryScopeChanged(
        roleBefore,
        workspaceA,
        roleAfter,
        workspaceA,
      ),
    ).toBe(false);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let catalogReads = 0;
    const catalogObserver = new QueryObserver(queryClient, {
      queryKey: ["catalog", "connection-a"],
      queryFn: async () => ++catalogReads,
    });
    const stopCatalog = catalogObserver.subscribe(() => undefined);
    await catalogObserver.refetch();
    await resetConnectionResourceQueries(queryClient, ["connection-a"]);
    expect(catalogReads).toBe(2);
    expect(catalogObserver.getCurrentResult().data).toBe(2);

    let privateReads = 0;
    const privateObserver = new QueryObserver(queryClient, {
      queryKey: ["providerCredentials"],
      queryFn: async () => ++privateReads,
    });
    const stopPrivate = privateObserver.subscribe(() => undefined);
    await privateObserver.refetch();
    await resetWorkspaceResourceQueries(queryClient);
    expect(privateReads).toBe(1);
    expect(privateObserver.getCurrentResult().data).toBeUndefined();
    // WorkspaceAccount performs this only when authority changed but the observer
    // key did not (for example, an admin-to-viewer membership update).
    await refetchWorkspaceResourceQueries(queryClient);
    expect(privateReads).toBe(2);
    expect(privateObserver.getCurrentResult().data).toBe(2);

    // Startup authority verification can race the Explorer's first Knowledge read.
    // TanStack reverts that cancelled observer to pending + idle, so the verified
    // unchanged-authority path must explicitly resume it rather than refreshing only
    // the Connections query owned by AppShell.
    let knowledgeReads = 0;
    const knowledgeObserver = new QueryObserver(queryClient, {
      queryKey: ["knowledge", "projects", "scope-a"],
      queryFn: ({ signal }) => {
        knowledgeReads += 1;
        if (knowledgeReads > 1) return Promise.resolve(["ready"]);
        return new Promise<string[]>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("authority verification", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const stopKnowledge = knowledgeObserver.subscribe(() => undefined);
    await Promise.resolve();
    expect(knowledgeObserver.getCurrentResult().fetchStatus).toBe("fetching");
    await cancelWorkspaceResourceQueries(queryClient);
    expect(knowledgeObserver.getCurrentResult().status).toBe("pending");
    expect(knowledgeObserver.getCurrentResult().fetchStatus).toBe("idle");
    await refetchWorkspaceResourceQueries(queryClient);
    expect(knowledgeReads).toBe(2);
    expect(knowledgeObserver.getCurrentResult().data).toEqual(["ready"]);

    let oldReadAborted = false;
    const pendingOldRead = queryClient.fetchQuery({
      queryKey: ["knowledgeSources", "old-workspace"],
      queryFn: ({ signal }) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          oldReadAborted = true;
          reject(new DOMException("workspace changed", "AbortError"));
        }, { once: true });
      }),
    });
    await Promise.resolve();
    await expect(
      runWorkspaceAuthorityTransition(
        queryClient,
        async () => {
          expect(oldReadAborted).toBe(true);
        },
        async () => {
          // A synchronization failure may race a newly started private read. The
          // transition must fail closed and remove that partial new-scope state.
          queryClient.setQueryData(["knowledgeSources", "new-workspace"], ["partial"]);
          throw new Error("context synchronization failed");
        },
      ),
    ).rejects.toThrow("context synchronization failed");
    await pendingOldRead.catch(() => undefined);
    expect(
      queryClient.getQueryData(["knowledgeSources", "new-workspace"]),
    ).toBeUndefined();
    stopKnowledge();
    stopPrivate();
    stopCatalog();
    queryClient.clear();
  });
});
