// Cross-language fixture coverage for independently deployed Workspace Cloud and
// Desktop. The fixture contains fake secrets; assertions never print or snapshot it.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_CONTRACTS_SCHEMA_VERSION,
  managedLeaseResponse,
  MANAGED_LEASE_CONTRACT_VERSION,
  parseManagedLeaseRequest,
  parseWorkspaceSyncPage,
} from "./control-plane-contracts";
import {
  parseProductAnalyticsEnvelope,
  type ProductEventName,
} from "./product-analytics";
import { parseSharedAnalysisArticleCreate } from "./workspace-analysis-articles";

type Fixture = Readonly<{
  schemaVersion: number;
  workspaceSync: Readonly<{
    bootstrap: unknown;
    incremental: unknown;
    reset: unknown;
  }>;
  managedLease: Readonly<{
    contractHeader: string;
    request: unknown;
    response: unknown;
  }>;
  analysisArticleCreate: unknown;
  analysisArticleAcceptances: readonly Readonly<{
    name: string;
    mutations: SemanticRejection["mutations"];
  }>[];
  semanticRejections: readonly SemanticRejection[];
}>;

type SemanticRejection = Readonly<{
  name: string;
  contract:
    | "workspaceSyncBootstrap"
    | "workspaceSyncIncremental"
    | "managedLeaseRequest"
    | "managedLeaseResponse"
    | "analysisArticleCreate";
  mutations: readonly Readonly<{
    path: readonly (string | number)[];
    value: unknown;
  }>[];
}>;

const fixture = JSON.parse(readFileSync(
  new URL(
    "../../dopedb-protocol/tests/fixtures/control-plane-contracts-v1.json",
    import.meta.url,
  ),
  "utf8",
)) as Fixture;

function applySemanticMutations(base: unknown, rejection: SemanticRejection) {
  const candidate: unknown = structuredClone(base);
  for (const mutation of rejection.mutations) {
    const last = mutation.path.at(-1);
    if (last === undefined) throw new Error("Semantic rejection path must not be empty");
    let cursor = candidate;
    for (const segment of mutation.path.slice(0, -1)) {
      if (typeof segment === "number" && Array.isArray(cursor)) {
        cursor = cursor[segment];
      } else if (typeof segment === "string" && cursor && typeof cursor === "object") {
        cursor = (cursor as Record<string, unknown>)[segment];
      } else {
        throw new Error("Semantic rejection path is invalid");
      }
    }
    if (typeof last === "number" && Array.isArray(cursor)) {
      cursor[last] = structuredClone(mutation.value);
    } else if (typeof last === "string" && cursor && typeof cursor === "object") {
      (cursor as Record<string, unknown>)[last] = structuredClone(mutation.value);
    } else {
      throw new Error("Semantic rejection target is invalid");
    }
  }
  return candidate;
}

const analyticsNow = Date.parse("2026-08-14T00:00:00Z");
const analyticsActorKey = "a".repeat(64);
const analyticsWorkspaceKey = "b".repeat(64);
const analyticsEventProperties: Record<ProductEventName, Record<string, unknown>> = {
  desktop_installation_ready: {},
  workspace_authentication_completed: { outcome: "success" },
  workspace_scope_ready: { syncState: "ok" },
  knowledge_environment_created: { creationKind: "project_default" },
  connection_verification_completed: {
    outcome: "success",
    engine: "postgres",
    credentialMode: "local",
    ssh: false,
  },
  environment_connection_bound: { accessMode: "local", engine: "postgres" },
  query_execution_completed: {
    outcome: "success",
    statementClass: "select",
    rowCountBucket: "zero",
    durationBucket: "under_100ms",
    approvalRequired: false,
  },
  knowledge_source_sync_completed: {
    outcome: "success",
    sourceKind: "github",
    syncReason: "webhook",
  },
  agent_session_initialization_completed: { outcome: "success", provider: "codex" },
  agent_turn_completed: {
    outcome: "success",
    provider: "codex",
    durationBucket: "1s_10s",
  },
  analysis_article_proposal_completed: { outcome: "success" },
  analysis_article_run_completed: {
    outcome: "success",
    trigger: "agent_test",
    durationBucket: "10s_60s",
  },
  analysis_article_state_transitioned: { fromState: "draft", toState: "review" },
  workspace_member_joined: { role: "editor" },
  shared_connection_access_ready: { accessMode: "managed", engine: "postgres" },
};

function analyticsEnvelope(
  name: ProductEventName,
  identity: Record<string, unknown>,
  properties = analyticsEventProperties[name],
) {
  return {
    schemaVersion: 1,
    installationId: "018f1f7e-7b44-7cc1-8d4e-4f31b7315fe8",
    sessionId: "018f1f7e-7b44-7cc1-8d4e-4f31b7315fe9",
    appVersion: "0.3.45",
    platform: "macos",
    locale: "ko",
    events: [{
      eventId: "c".repeat(64),
      name,
      occurredAt: "2026-08-14T00:00:00Z",
      ...identity,
      properties,
    }],
  };
}

describe("Desktop control-plane contracts", () => {
  it("decodes the same strict sync, lease, and Analysis Article goldens as Rust", () => {
    expect(fixture.schemaVersion).toBe(CONTROL_PLANE_CONTRACTS_SCHEMA_VERSION);
    for (const page of [
      fixture.workspaceSync.bootstrap,
      fixture.workspaceSync.incremental,
      fixture.workspaceSync.reset,
    ]) {
      expect(parseWorkspaceSyncPage(page)).toEqual(page);
    }
    expect(fixture.managedLease.contractHeader).toBe(MANAGED_LEASE_CONTRACT_VERSION);
    expect(parseManagedLeaseRequest(fixture.managedLease.request))
      .toEqual(fixture.managedLease.request);
    const lease = managedLeaseResponse(fixture.managedLease.response);
    expect(lease.lease.provider).toBe("gcpCloudSql");
    expect(lease.lease.connector?.kind).toBe("gcpCloudSqlAuthProxy");
    expect(parseSharedAnalysisArticleCreate(fixture.analysisArticleCreate))
      .toEqual(fixture.analysisArticleCreate);

    for (const acceptance of fixture.analysisArticleAcceptances) {
      const candidate = applySemanticMutations(
        fixture.analysisArticleCreate,
        { ...acceptance, contract: "analysisArticleCreate" },
      );
      let accepted = true;
      try {
        parseSharedAnalysisArticleCreate(candidate);
      } catch {
        accepted = false;
      }
      expect(accepted, acceptance.name).toBe(true);
    }

    for (const rejection of fixture.semanticRejections) {
      const base = rejection.contract === "workspaceSyncBootstrap"
        ? fixture.workspaceSync.bootstrap
        : rejection.contract === "workspaceSyncIncremental"
          ? fixture.workspaceSync.incremental
          : rejection.contract === "managedLeaseRequest"
        ? fixture.managedLease.request
        : rejection.contract === "managedLeaseResponse"
          ? fixture.managedLease.response
          : fixture.analysisArticleCreate;
      const candidate = applySemanticMutations(base, rejection);
      let rejected = false;
      try {
        if (rejection.contract === "workspaceSyncBootstrap"
          || rejection.contract === "workspaceSyncIncremental") parseWorkspaceSyncPage(candidate);
        else if (rejection.contract === "managedLeaseRequest") parseManagedLeaseRequest(candidate);
        else if (rejection.contract === "managedLeaseResponse") managedLeaseResponse(candidate);
        else parseSharedAnalysisArticleCreate(candidate);
      } catch {
        rejected = true;
      }
      expect(rejected, rejection.name).toBe(true);
    }

    expect(() => parseWorkspaceSyncPage({
      ...(fixture.workspaceSync.bootstrap as object),
      unexpected: true,
    })).toThrow("Invalid workspace sync contract");
    expect(() => managedLeaseResponse({
      ...(fixture.managedLease.response as { lease: object }),
      lease: {
        ...(fixture.managedLease.response as { lease: object }).lease,
        unexpected: true,
      },
    })).toThrow("Invalid managed lease response contract");
    expect(() => parseSharedAnalysisArticleCreate({
      ...(fixture.analysisArticleCreate as object),
      unexpected: true,
    })).toThrow();

    expect(parseProductAnalyticsEnvelope(
      analyticsEnvelope("desktop_installation_ready", {}),
      analyticsNow,
    )).not.toBeNull();
    expect(parseProductAnalyticsEnvelope({
      ...analyticsEnvelope("desktop_installation_ready", {}),
      events: [{
        ...analyticsEnvelope("desktop_installation_ready", {}).events[0],
        eventId: "018f1f7e-7b44-7cc1-8d4e-4f31b7315fe7",
      }],
    }, analyticsNow)).toBeNull();
    expect(parseProductAnalyticsEnvelope(
      analyticsEnvelope("desktop_installation_ready", { actorKey: analyticsActorKey }),
      analyticsNow,
    )).toBeNull();
    expect(parseProductAnalyticsEnvelope(
      analyticsEnvelope("workspace_authentication_completed", { actorKey: analyticsActorKey }),
      analyticsNow,
    )).not.toBeNull();
    expect(parseProductAnalyticsEnvelope(
      analyticsEnvelope("workspace_authentication_completed", {
        actorKey: analyticsActorKey,
        workspaceKey: analyticsWorkspaceKey,
        workspaceKind: "team",
      }),
      analyticsNow,
    )).toBeNull();
    expect(parseProductAnalyticsEnvelope(
      analyticsEnvelope("workspace_authentication_completed", {}),
      analyticsNow,
    )).toBeNull();
    expect(parseProductAnalyticsEnvelope(
      analyticsEnvelope("workspace_authentication_completed", {}, { outcome: "failed" }),
      analyticsNow,
    )).not.toBeNull();
    expect(parseProductAnalyticsEnvelope(
      analyticsEnvelope(
        "workspace_authentication_completed",
        { actorKey: analyticsActorKey },
        { outcome: "failed" },
      ),
      analyticsNow,
    )).toBeNull();

    for (const name of Object.keys(analyticsEventProperties) as ProductEventName[]) {
      if (name === "desktop_installation_ready" || name === "workspace_authentication_completed") {
        continue;
      }
      expect(parseProductAnalyticsEnvelope(analyticsEnvelope(name, {}), analyticsNow), name)
        .toBeNull();
      expect(parseProductAnalyticsEnvelope(analyticsEnvelope(name, {
        workspaceKey: analyticsWorkspaceKey,
        workspaceKind: "team",
      }), analyticsNow), name).toBeNull();
      expect(parseProductAnalyticsEnvelope(analyticsEnvelope(name, {
        actorKey: analyticsActorKey,
        workspaceKey: analyticsWorkspaceKey,
        workspaceKind: "team",
      }), analyticsNow), name).not.toBeNull();
    }
    expect(parseProductAnalyticsEnvelope(analyticsEnvelope("workspace_scope_ready", {
      workspaceKey: analyticsWorkspaceKey,
      workspaceKind: "personal",
    }), analyticsNow)).not.toBeNull();
    expect(parseProductAnalyticsEnvelope(analyticsEnvelope("workspace_scope_ready", {
      actorKey: analyticsActorKey,
      workspaceKey: analyticsWorkspaceKey,
      workspaceKind: "personal",
    }), analyticsNow)).toBeNull();
    expect(parseProductAnalyticsEnvelope(analyticsEnvelope("workspace_member_joined", {
      workspaceKey: analyticsWorkspaceKey,
      workspaceKind: "personal",
    }), analyticsNow)).toBeNull();
    expect(parseProductAnalyticsEnvelope(analyticsEnvelope(
      "analysis_article_state_transitioned",
      {
        actorKey: analyticsActorKey,
        workspaceKey: analyticsWorkspaceKey,
        workspaceKind: "team",
      },
      { fromState: "review", toState: "review" },
    ), analyticsNow)).toBeNull();
  });
});
