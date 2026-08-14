import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import capability from "../../../src-tauri/capabilities/default.json";
import { knowledgeQueryKeys } from "../knowledge/queryKeys";
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
import {
  ProductAnalyticsLocalStore,
  productAnalyticsInstallationReadyInput,
  type ProductAnalyticsStorage,
} from "../productAnalytics/storage";
import {
  isProductAnalyticsEventInput,
  type QueuedProductAnalyticsEvent,
} from "../productAnalytics/domain";
import {
  productAnalyticsAccessMode,
  productAnalyticsConnectionEngine,
  productAnalyticsCredentialMode,
  productAnalyticsDurationBucket,
  productAnalyticsRowCountBucket,
  productAnalyticsStatementClass,
  productAnalyticsWorkspaceContext,
} from "../productAnalytics/outcomes";

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
    expect(allowedUrls).toContain("https://dopedb.dev/privacy");
    expect(allowedUrls).not.toContain("https://github.com/*");

    const analyticsMemory = new Map<string, string>();
    const analyticsStorage: ProductAnalyticsStorage = {
      getItem: (key) => analyticsMemory.get(key) ?? null,
      setItem: (key, value) => analyticsMemory.set(key, value),
      removeItem: (key) => analyticsMemory.delete(key),
    };
    const analyticsNow = () => Date.parse("2026-08-13T00:00:00Z");
    const analyticsStore = new ProductAnalyticsLocalStore(
      analyticsStorage,
      analyticsNow,
    );
    const analyticsEvent = (
      sessionId: string,
      eventId: string,
    ): QueuedProductAnalyticsEvent => ({
      sessionId,
      appVersion: "0.3.49",
      platform: "macos",
      locale: "en",
      event: {
        eventId,
        name: "desktop_installation_ready",
        occurredAt: "2026-08-13T00:00:00Z",
        properties: {},
      },
    });
    const firstAnalyticsEvent = analyticsEvent(
      "10000000-0000-4000-8000-000000000001",
      "a".repeat(64),
    );
    let installationAllocations = 0;
    const allocateInstallation = () => {
      installationAllocations += 1;
      return "10000000-0000-4000-8000-000000000003";
    };
    expect(analyticsStore.enqueue(firstAnalyticsEvent)).toBe(false);
    expect(analyticsStore.ensureInstallation(allocateInstallation)).toBeNull();
    expect(installationAllocations).toBe(0);
    expect(analyticsMemory.size).toBe(0);
    analyticsStore.applyConsent("granted");
    const installation = analyticsStore.ensureInstallation(allocateInstallation);
    expect(installation?.id).toBe("10000000-0000-4000-8000-000000000003");
    if (!installation) throw new Error("analytics installation was not created");
    expect(analyticsStore.ensureInstallation(allocateInstallation)).toEqual(
      installation,
    );
    expect(installationAllocations).toBe(1);
    expect(productAnalyticsInstallationReadyInput(installation)).toMatchObject({
      name: "desktop_installation_ready",
      dedupeId: installation.id,
      properties: {},
    });
    const installationStorageEntry = [...analyticsMemory.entries()].find(
      ([, value]) => value.includes(installation.id),
    );
    if (!installationStorageEntry) {
      throw new Error("analytics installation was not persisted");
    }
    analyticsMemory.set(installationStorageEntry[0], JSON.stringify({
      id: installation.id,
      createdAt: "2026-08-13T00:00:00Z",
    }));
    const migratedAnalyticsStore = new ProductAnalyticsLocalStore(
      analyticsStorage,
      analyticsNow,
    );
    migratedAnalyticsStore.applyConsent("granted");
    expect(migratedAnalyticsStore.installation()).toEqual({
      ...installation,
      readyRecorded: false,
    });
    expect(migratedAnalyticsStore.enqueue(analyticsEvent(
      "10000000-0000-4000-8000-000000000001",
      "018f1f7e-7b44-7cc1-8d4e-4f31b7315fe7",
    ))).toBe(false);
    expect(migratedAnalyticsStore.enqueue(firstAnalyticsEvent)).toBe(true);
    expect(migratedAnalyticsStore.enqueue(firstAnalyticsEvent)).toBe(true);
    expect(migratedAnalyticsStore.getSnapshot().queueSize).toBe(1);
    expect(
      migratedAnalyticsStore.markInstallationReadyRecorded(installation.id),
    ).toBe(true);
    expect(migratedAnalyticsStore.installation()?.readyRecorded).toBe(true);
    if (firstAnalyticsEvent.event.name !== "desktop_installation_ready") {
      throw new Error("unexpected product analytics event");
    }
    (firstAnalyticsEvent.event.properties as Record<string, unknown>).sql =
      "select must-not-survive";
    const relaunchedAnalyticsStore = new ProductAnalyticsLocalStore(
      analyticsStorage,
      analyticsNow,
    );
    relaunchedAnalyticsStore.applyConsent("granted");
    expect(relaunchedAnalyticsStore.installation()?.readyRecorded).toBe(true);
    expect(relaunchedAnalyticsStore.enqueue(analyticsEvent(
      "10000000-0000-4000-8000-000000000001",
      "a".repeat(64),
    ))).toBe(true);
    expect(relaunchedAnalyticsStore.getSnapshot().queueSize).toBe(1);
    const isolatedAnalyticsEvent = relaunchedAnalyticsStore.peekBatch()[0]?.event;
    if (isolatedAnalyticsEvent?.name !== "desktop_installation_ready") {
      throw new Error("queued product analytics event was not preserved");
    }
    expect(isolatedAnalyticsEvent.properties).toEqual({});
    expect(relaunchedAnalyticsStore.enqueue(analyticsEvent(
      "10000000-0000-4000-8000-000000000002",
      "b".repeat(64),
    ))).toBe(true);
    expect(
      relaunchedAnalyticsStore.peekBatch().map((item) => item.event.eventId),
    ).toEqual(["a".repeat(64)]);
    relaunchedAnalyticsStore.applyConsent("denied");
    expect(relaunchedAnalyticsStore.getSnapshot()).toEqual({
      consent: "denied",
      queueSize: 0,
    });
    expect(relaunchedAnalyticsStore.installation()).toBeNull();
    expect(analyticsMemory.size).toBe(0);

    const analyticsWorkspaceId = "20000000-0000-4000-8000-000000000001";
    const analyticsActorId = "20000000-0000-4000-8000-000000000002";
    const personalAnalyticsContext = productAnalyticsWorkspaceContext({
      key: "personal-ready",
      ready: true,
      workspaceId: analyticsWorkspaceId,
      accountScope: null,
      workspaceKind: "personal",
    });
    expect(personalAnalyticsContext).toEqual({
      workspaceId: analyticsWorkspaceId,
      workspaceKind: "personal",
    });
    expect(productAnalyticsWorkspaceContext({
      key: "team-not-ready",
      ready: false,
      workspaceId: analyticsWorkspaceId,
      accountScope: analyticsActorId,
      workspaceKind: "team",
    })).toBeNull();
    expect(productAnalyticsWorkspaceContext({
      key: "team-missing-actor",
      ready: true,
      workspaceId: analyticsWorkspaceId,
      accountScope: null,
      workspaceKind: "team",
    })).toBeNull();
    expect(productAnalyticsWorkspaceContext({
      key: "team-ready",
      ready: true,
      workspaceId: analyticsWorkspaceId,
      accountScope: analyticsActorId,
      workspaceKind: "team",
    })).toEqual({
      workspaceId: analyticsWorkspaceId,
      workspaceKind: "team",
      actorId: analyticsActorId,
    });
    expect([
      productAnalyticsDurationBucket(-1),
      productAnalyticsDurationBucket(99),
      productAnalyticsDurationBucket(100),
      productAnalyticsDurationBucket(1_000),
      productAnalyticsDurationBucket(10_000),
      productAnalyticsDurationBucket(60_000),
    ]).toEqual([
      "unknown",
      "under_100ms",
      "100ms_1s",
      "1s_10s",
      "10s_60s",
      "over_60s",
    ]);
    expect([
      productAnalyticsRowCountBucket(-1),
      productAnalyticsRowCountBucket(0),
      productAnalyticsRowCountBucket(1),
      productAnalyticsRowCountBucket(10),
      productAnalyticsRowCountBucket(100),
      productAnalyticsRowCountBucket(1_000),
      productAnalyticsRowCountBucket(1_001),
    ]).toEqual([
      "unknown",
      "zero",
      "one",
      "2_10",
      "11_100",
      "101_1000",
      "over_1000",
    ]);
    expect(productAnalyticsStatementClass(
      " /* leading ; comment */ -- another comment\n SELECT ';'",
    )).toBe("select");
    expect(productAnalyticsStatementClass("EXPLAIN SELECT 1")).toBe("explain");
    expect(productAnalyticsStatementClass("# comment\n SHOW TABLES")).toBe("show");
    expect(productAnalyticsStatementClass(
      "WITH changed AS (DELETE FROM sample RETURNING *) SELECT * FROM changed",
    )).toBe("write");
    expect(productAnalyticsStatementClass(
      "WITH sample AS (SELECT 1) SELECT * FROM sample",
    )).toBe("select");
    expect(productAnalyticsStatementClass(
      "SELECT ';'; /* separator ; */ SELECT 2",
    )).toBe("script");
    expect(productAnalyticsConnectionEngine("sqlite")).toBe("sqlite");
    expect(productAnalyticsAccessMode("memberLocal")).toBe("local");
    expect(productAnalyticsAccessMode("managed")).toBe("managed");
    expect(productAnalyticsCredentialMode(null)).toBe("none");
    expect(productAnalyticsCredentialMode("local")).toBe("local");
    expect(productAnalyticsCredentialMode("managed")).toBe("managed");
    const validQueryAnalyticsInput = {
      name: "query_execution_completed",
      properties: {
        outcome: "success",
        statementClass: "select",
        rowCountBucket: "one",
        durationBucket: "under_100ms",
        approvalRequired: false,
      },
      context: personalAnalyticsContext,
    } as const;
    expect(isProductAnalyticsEventInput(validQueryAnalyticsInput)).toBe(true);
    expect(isProductAnalyticsEventInput({
      ...validQueryAnalyticsInput,
      properties: {
        ...validQueryAnalyticsInput.properties,
        sql: "SELECT private_value",
      },
    })).toBe(false);
    expect(isProductAnalyticsEventInput({
      ...validQueryAnalyticsInput,
      error: "private error detail",
    })).toBe(false);

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

    let agentEnvironmentReads = 0;
    const agentEnvironmentObserver = new QueryObserver(queryClient, {
      queryKey: knowledgeQueryKeys.agentEnvironments(
        "connection-a",
        "scope-a",
      ),
      queryFn: async () => ++agentEnvironmentReads,
    });
    const stopAgentEnvironments = agentEnvironmentObserver.subscribe(
      () => undefined,
    );
    await agentEnvironmentObserver.refetch();
    await resetConnectionResourceQueries(queryClient, ["connection-a"]);
    expect(agentEnvironmentReads).toBe(2);

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
      queryKey: knowledgeQueryKeys.projects("scope-a"),
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
    stopAgentEnvironments();
    stopPrivate();
    stopCatalog();
    queryClient.clear();
  });
});
