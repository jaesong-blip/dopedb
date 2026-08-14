// Cross-language fixture coverage for independently deployed Workspace Cloud and
// Desktop. The fixture contains fake secrets; assertions never print or snapshot it.

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  CONTROL_PLANE_CONTRACTS_SCHEMA_VERSION,
  managedLeaseResponse,
  MANAGED_LEASE_CONTRACT_VERSION,
  parseManagedLeaseRequest,
  parseWorkspaceSyncPage,
} from "./control-plane-contracts";
import {
  acceptsProductAnalyticsContract,
  parseProductAnalyticsEnvelope,
  productAnalyticsEnvelopeBudgetPlan,
  productAnalyticsIngressBudgetPlan,
  relayProductAnalytics,
  type ProductAnalyticsEnvelope,
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

const productAnalyticsGolden = JSON.parse(readFileSync(
  new URL("../../tests/fixtures/product-analytics-v1.json", import.meta.url),
  "utf8",
)) as ProductAnalyticsEnvelope;

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
const analyticsEventProperties = Object.fromEntries(
  productAnalyticsGolden.events.map((event) => [event.name, event.properties]),
) as Record<ProductEventName, Record<string, unknown>>;
const analyticsPropertyKeys = {
  desktop_installation_ready: [],
  workspace_authentication_completed: ["outcome"],
  workspace_scope_ready: [],
  knowledge_environment_created: ["creationKind"],
  connection_verification_completed: ["outcome", "engine", "credentialMode", "ssh"],
  environment_connection_bound: ["accessMode", "engine"],
  query_execution_completed: [
    "outcome",
    "statementClass",
    "rowCountBucket",
    "durationBucket",
    "approvalRequired",
  ],
  knowledge_source_sync_completed: ["outcome", "sourceKind", "syncReason"],
  agent_session_initialization_completed: ["outcome", "provider"],
  agent_turn_completed: ["outcome", "provider", "durationBucket"],
  analysis_article_proposal_completed: [],
  analysis_article_run_completed: ["outcome", "trigger", "durationBucket"],
  analysis_article_state_transitioned: ["fromState", "toState"],
  workspace_membership_ready: ["role"],
  shared_connection_access_ready: ["accessMode", "engine"],
} as const satisfies Record<ProductEventName, readonly string[]>;

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
  it("decodes the same strict sync, lease, and Analysis Article goldens as Rust", async () => {
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

    expect(Object.keys(productAnalyticsGolden).sort()).toEqual([
      "appVersion",
      "events",
      "installationId",
      "locale",
      "platform",
      "schemaVersion",
      "sessionId",
    ]);
    expect(parseProductAnalyticsEnvelope(productAnalyticsGolden, analyticsNow))
      .toEqual(productAnalyticsGolden);
    expect(productAnalyticsGolden.events.map((event) => event.name)).toEqual(
      Object.keys(analyticsPropertyKeys),
    );
    for (const event of productAnalyticsGolden.events) {
      expect(Object.keys(event.properties).sort(), event.name).toEqual(
        [...analyticsPropertyKeys[event.name]].sort(),
      );
      const identityKeys = event.name === "desktop_installation_ready"
        ? []
        : event.name === "workspace_authentication_completed"
          ? ["actorKey"]
          : event.workspaceKind === "personal"
            ? ["workspaceKey", "workspaceKind"]
            : ["actorKey", "workspaceKey", "workspaceKind"];
      expect(Object.keys(event).sort(), event.name).toEqual([
        "eventId",
        "name",
        "occurredAt",
        "properties",
        ...identityKeys,
      ].sort());
    }
    expect(productAnalyticsGolden.events[2]?.workspaceKind).toBe("personal");
    expect(productAnalyticsGolden.events.at(-2)?.workspaceKind).toBe("team");

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
    expect(parseProductAnalyticsEnvelope(analyticsEnvelope("workspace_membership_ready", {
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

    expect(acceptsProductAnalyticsContract(new Headers({
      "x-dopedb-product-analytics-contract": "1",
    }))).toBe(true);
    for (const value of [undefined, "01", "2", "1, 1"]) {
      const headers = new Headers();
      if (value !== undefined) headers.set("x-dopedb-product-analytics-contract", value);
      expect(acceptsProductAnalyticsContract(headers), value).toBe(false);
    }

    const firstInstallation = "018f1f7e-7b44-7cc1-8d4e-4f31b7315fe8";
    const secondInstallation = "018f1f7e-7b44-7cc1-8d4e-4f31b7315fea";
    const sourceHeaders = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    const firstIngressPlan = productAnalyticsIngressBudgetPlan(sourceHeaders);
    const rotatedIngressPlan = productAnalyticsIngressBudgetPlan(sourceHeaders);
    const otherSourceIngressPlan = productAnalyticsIngressBudgetPlan(
      new Headers({ "x-forwarded-for": "198.51.100.9" }),
    );
    const firstEnvelopePlan = productAnalyticsEnvelopeBudgetPlan(firstInstallation, 1);
    const rotatedEnvelopePlan = productAnalyticsEnvelopeBudgetPlan(secondInstallation, 1);
    expect(firstIngressPlan.map(({ namespace, limit, windowMs }) => ({
      namespace,
      limit,
      windowMs,
    }))).toEqual([
      { namespace: "product-analytics-global-requests", limit: 400, windowMs: 60_000 },
      { namespace: "product-analytics-ip", limit: 60, windowMs: 60_000 },
    ]);
    expect(firstEnvelopePlan.map(({ namespace, limit, windowMs }) => ({
      namespace,
      limit,
      windowMs,
    }))).toEqual([
      { namespace: "product-analytics-global-events", limit: 16, windowMs: 60_000 },
      { namespace: "product-analytics-installation", limit: 60, windowMs: 60_000 },
    ]);
    expect([...firstIngressPlan, ...firstEnvelopePlan].every(
      ({ discriminator }) => /^[0-9a-f]{64}$/.test(discriminator),
    )).toBe(true);
    expect(firstIngressPlan[0].discriminator).toBe(rotatedIngressPlan[0].discriminator);
    expect(firstIngressPlan[1].discriminator).toBe(rotatedIngressPlan[1].discriminator);
    expect(firstIngressPlan[1].discriminator)
      .not.toBe(otherSourceIngressPlan[1].discriminator);
    expect(firstEnvelopePlan[0].discriminator).toBe(rotatedEnvelopePlan[0].discriminator);
    expect(firstEnvelopePlan[1].discriminator)
      .not.toBe(rotatedEnvelopePlan[1].discriminator);
    expect(productAnalyticsEnvelopeBudgetPlan(firstInstallation, 16)[0].cost)
      .toBe(16);
    expect(JSON.stringify(firstIngressPlan)).not.toContain("203.0.113.7");
    expect(JSON.stringify(firstEnvelopePlan)).not.toContain(firstInstallation);

    const relayEnvelope = parseProductAnalyticsEnvelope(productAnalyticsGolden, analyticsNow);
    expect(relayEnvelope).not.toBeNull();
    const previousToken = process.env.PRODUCT_ANALYTICS_CLOUDFLARE_TOKEN;
    const previousUrl = process.env.PRODUCT_ANALYTICS_CLOUDFLARE_URL;
    const previousRelayEnabled = process.env.PRODUCT_ANALYTICS_RELAY_ENABLED;
    process.env.PRODUCT_ANALYTICS_RELAY_ENABLED = "1";
    process.env.PRODUCT_ANALYTICS_CLOUDFLARE_TOKEN = "a".repeat(64);
    process.env.PRODUCT_ANALYTICS_CLOUDFLARE_URL =
      "https://dopedb-product-analytics.test.workers.dev/v1/events";
    let relayTarget = "";
    let relayBody: unknown;
    let relayHeaders = new Headers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      relayTarget = String(input);
      relayHeaders = new Headers(init?.headers);
      if (typeof init?.body !== "string") throw new Error("Expected a JSON relay body");
      relayBody = JSON.parse(init.body) as unknown;
      return new Response(null, { status: 202 });
    });
    try {
      expect(await relayProductAnalytics(relayEnvelope!)).toBe("accepted");
      expect(relayTarget).toBe(
        "https://dopedb-product-analytics.test.workers.dev/v1/events",
      );
      expect(relayHeaders.get("authorization")).toBe(`Bearer ${"a".repeat(64)}`);
      expect(relayHeaders.get("x-dopedb-product-analytics-contract")).toBe("1");
      expect(relayBody).toEqual(relayEnvelope);
      expect(JSON.stringify(relayBody)).not.toContain("consentGeneration");

      const analyticsModule = await import("./product-analytics");
      const ingressBudget = vi.spyOn(
        analyticsModule,
        "consumeProductAnalyticsIngressBudget",
      ).mockResolvedValue(true);
      const envelopeBudget = vi.spyOn(
        analyticsModule,
        "consumeProductAnalyticsEnvelopeBudget",
      ).mockResolvedValue(true);
      try {
        fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
        const currentEnvelope = structuredClone(productAnalyticsGolden);
        const occurredAt = new Date().toISOString();
        for (const event of currentEnvelope.events) event.occurredAt = occurredAt;
        const { POST } = await import(
          "../app/api/v1/product-analytics/events/route"
        );
        process.env.PRODUCT_ANALYTICS_RELAY_ENABLED = "0";
        const disabled = await POST(new Request(
          "https://workspace.dopedb.dev/api/v1/product-analytics/events",
          { method: "POST", body: "{}" },
        ));
        expect(disabled.status).toBe(503);
        expect(ingressBudget).not.toHaveBeenCalled();
        process.env.PRODUCT_ANALYTICS_RELAY_ENABLED = "1";
        const response = await POST(new Request(
          "https://workspace.dopedb.dev/api/v1/product-analytics/events",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-dopedb-product-analytics-contract": "1",
            },
            body: JSON.stringify(currentEnvelope),
          },
        ));
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({
          accepted: false,
          error: "Product analytics relay rejected the batch",
          retryable: false,
        });
      } finally {
        ingressBudget.mockRestore();
        envelopeBudget.mockRestore();
      }
    } finally {
      fetchMock.mockRestore();
      if (previousToken === undefined) delete process.env.PRODUCT_ANALYTICS_CLOUDFLARE_TOKEN;
      else process.env.PRODUCT_ANALYTICS_CLOUDFLARE_TOKEN = previousToken;
      if (previousUrl === undefined) delete process.env.PRODUCT_ANALYTICS_CLOUDFLARE_URL;
      else process.env.PRODUCT_ANALYTICS_CLOUDFLARE_URL = previousUrl;
      if (previousRelayEnabled === undefined) delete process.env.PRODUCT_ANALYTICS_RELAY_ENABLED;
      else process.env.PRODUCT_ANALYTICS_RELAY_ENABLED = previousRelayEnabled;
    }
  });
});
