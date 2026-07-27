import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const authoritySqlMock = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({ db: { execute: executeMock } }));
vi.mock("./provider-integrations", () => ({
  providerMutationAuthoritySql: authoritySqlMock,
}));

import {
  claimPlanetScaleCredentialRefresh,
  finalizePlanetScaleCredentialRefresh,
  markPlanetScaleCredentialRefreshRemoteStarted,
  markProviderIntegrationProviderRevokeAmbiguous,
  persistProviderIntegration,
  PROVIDER_INTEGRATION_DURABLE_MUTATION_ENTRYPOINTS,
  releasePlanetScaleCredentialRefreshClaim,
  requirePlanetScaleCredentialReconnect,
  resumeProviderIntegrationDisconnect,
} from "./provider-integration-mutation-store";

const authority = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  membershipId: "member-id", userId: "user-id", sessionId: "session-id",
  role: "admin" as const,
};

function input(existing = false) {
  return {
    authority, integrationId: "22222222-2222-4222-8222-222222222222",
    provider: "gcpCloudSql" as const, externalAccountId: "gcp:example",
    displayName: "GCP Cloud SQL", encryptedCredential: "sealed", credentialExpiresAt: null, grantedScope: "read",
    localVerificationTarget: {
      kind: "gcpCloudSql" as const,
      projectId: "sample-project-123",
      instanceId: "instance-one",
    },
    now: new Date("2026-07-27T00:00:00Z"),
    requestId: "33333333-3333-4333-8333-333333333333", revokedLeases: 0,
    principalClaims: [{
      principalFingerprint: "a".repeat(64), targetFingerprint: "b".repeat(64),
      accessKind: "read" as const,
    }],
    ...(existing ? { existing: {
      id: "22222222-2222-4222-8222-222222222222", status: "active",
      revokedAt: null, revocationPendingAt: null,
      generation: 1n,
      updatedAt: new Date("2026-07-26T00:00:00Z"),
    }, reconnectClaimId: "44444444-4444-4444-8444-444444444444" } : {}),
  };
}

beforeEach(() => {
  executeMock.mockReset();
  authoritySqlMock.mockReset();
  authoritySqlMock.mockImplementation(() => sql`authority_guard`);
});

describe("provider integration mutation store", () => {
  it("makes create claims, audit and connection effects depend on one authority mutation", async () => {
    executeMock.mockResolvedValue({ rows: [{ id: input().integrationId }] });
    await expect(persistProviderIntegration(input())).resolves.toEqual({
      ok: true, id: input().integrationId,
    });
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]?.[0] as SQL)
      .sql.replace(/\s+/g, " ");
    expect(query).toContain("WITH mutation AS ( INSERT INTO");
    expect(query).toContain("FROM desired_claims CROSS JOIN mutation");
    expect(query).toContain("FROM mutation WHERE connection");
    expect(query).toContain("FROM mutation RETURNING \"resource_id\"");
    expect(query).toContain('"local_verification_target"');
    expect(query).not.toContain("sealed");
  });

  it("accepts only the exact GCP target and never stores a local target for other providers", async () => {
    executeMock.mockResolvedValue({ rows: [{ id: input().integrationId }] });
    await expect(persistProviderIntegration({
      ...input(), localVerificationTarget: null,
    })).resolves.toEqual({ ok: false });
    await expect(persistProviderIntegration({
      ...input(), provider: "neon", localVerificationTarget: {
        kind: "gcpCloudSql", projectId: "sample-project-123", instanceId: "instance-one",
      },
    })).resolves.toEqual({ ok: false });
    await expect(persistProviderIntegration({
      ...input(), localVerificationTarget: {
        kind: "gcpCloudSql", projectId: "sample-project-123", instanceId: "instance-one", token: "no",
      } as never,
    })).resolves.toEqual({ ok: false });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("uses SQL NULL rather than JSON null for provider families without a local target", async () => {
    executeMock.mockResolvedValue({ rows: [{ id: input().integrationId }] });
    await expect(persistProviderIntegration({
      ...input(), provider: "neon", localVerificationTarget: null,
    })).resolves.toEqual({ ok: true, id: input().integrationId });
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]?.[0] as SQL)
      .sql.replace(/\s+/g, " ");
    expect(query).toMatch(/"local_verification_target".*SELECT.*NULL,/);
    expect(query).not.toContain("'null'::jsonb");
  });

  it("uses the exact pre-I/O generation and reconnect claim before clearing the gate", async () => {
    executeMock.mockResolvedValue({ rows: [] });
    await expect(persistProviderIntegration(input(true))).resolves.toEqual({ ok: false });
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]?.[0] as SQL)
      .sql.replace(/\s+/g, " ");
    expect(query).toContain("integration.\"revocation_claim_id\" = $");
    expect(query).toContain("integration.\"revocation_pending_at\" IS NOT NULL");
    expect(query).toContain("\"revocation_claim_id\" = NULL");
  });

  it("claims one PlanetScale refresh generation before I/O and finalizes only that claim", async () => {
    executeMock.mockResolvedValue({ rows: [{ id: input().integrationId }] });
    const refresh = {
      authority, integrationId: input().integrationId, generation: 7n,
      claimId: "55555555-5555-4555-8555-555555555555", now: new Date(),
    };
    await expect(claimPlanetScaleCredentialRefresh(refresh)).resolves.toBe(true);
    await expect(markPlanetScaleCredentialRefreshRemoteStarted(refresh))
      .resolves.toBe(true);
    await expect(finalizePlanetScaleCredentialRefresh({
      ...refresh, encryptedCredential: "sealed", credentialExpiresAt: new Date(), grantedScope: "read",
    })).resolves.toBe(true);
    const statements = executeMock.mock.calls.map(([statement]) => new PgDialect()
      .sqlToQuery(statement as SQL).sql.replace(/\s+/g, " ")).join("\n");
    expect(statements).toContain('"refresh_claim_id"');
    expect(statements).toContain('"refresh_generation"');
    expect(statements).toContain('"generation" = integration."generation" + 1');
    expect(statements).toContain('integration."refresh_phase" = \'remote_started\'');
    expect(statements).toContain('SET "status" = \'reconnect_required\'');
    expect(statements).toContain('SET "status" = \'active\'');
    expect(statements).toContain('integration."status" = \'reconnect_required\'');
    expect(statements).toContain("authority_guard");
    expect(authoritySqlMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requireManager: true,
      integration: expect.objectContaining({
        id: refresh.integrationId, provider: "planetScale", generation: refresh.generation,
        claimId: null,
      }),
    }));
    expect(authoritySqlMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requireManager: true,
      integration: expect.objectContaining({
        id: refresh.integrationId, provider: "planetScale", generation: refresh.generation,
        claimId: null,
      }),
    }));
  });

  it.each([
    "member demotion",
    "expired session",
    "member revocation",
    "integration revocation",
    "generation or claim replacement",
  ])("leaves a remote-started refresh fenced after %s", async () => {
    executeMock.mockResolvedValue({ rows: [] });
    const refresh = {
      authority, integrationId: input().integrationId, generation: 7n,
      claimId: "55555555-5555-4555-8555-555555555555", now: new Date(),
    };
    await expect(finalizePlanetScaleCredentialRefresh({
      ...refresh, encryptedCredential: "sealed", credentialExpiresAt: new Date(), grantedScope: "read",
    })).resolves.toBe(false);
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]?.[0] as SQL)
      .sql.replace(/\s+/g, " ");
    expect(query).toContain("authority_guard");
    expect(query).toContain('integration."refresh_phase" = \'remote_started\'');
    expect(executeMock).toHaveBeenCalledOnce();
    expect(authoritySqlMock).toHaveBeenCalledWith(expect.objectContaining({
      requireManager: true,
      integration: expect.objectContaining({
        id: refresh.integrationId, provider: "planetScale", generation: refresh.generation,
        claimId: null,
      }),
    }));
  });

  it("permits stale recovery only before remote I/O and fences every ambiguous outcome", async () => {
    executeMock.mockResolvedValue({ rows: [{ id: input().integrationId }] });
    const refresh = {
      authority, integrationId: input().integrationId, generation: 9n,
      claimId: "55555555-5555-4555-8555-555555555555", now: new Date(),
    };
    await claimPlanetScaleCredentialRefresh(refresh);
    await markPlanetScaleCredentialRefreshRemoteStarted(refresh);
    await releasePlanetScaleCredentialRefreshClaim(refresh);
    await requirePlanetScaleCredentialReconnect(refresh);
    const statements = executeMock.mock.calls.map(([statement]) => new PgDialect()
      .sqlToQuery(statement as SQL).sql.replace(/\s+/g, " ")).join("\n");
    expect(statements).toContain("integration.\"refresh_phase\" = 'claimed'");
    expect(statements).toContain("\"refresh_phase\" = 'remote_started'");
    expect(statements).toContain("integration.\"refresh_phase\" IN ('remote_started', 'reconnect_required')");
    expect(statements).toContain("\"status\" = 'reconnect_required'");
    // A five-minute takeover predicate is intentionally paired only with claimed.
    expect(statements).toContain("integration.\"refresh_phase\" = 'claimed' AND integration.\"refresh_claimed_at\" <");
  });

  it("makes an ambiguous provider revoke non-issuable until a fenced reconnect", async () => {
    executeMock.mockResolvedValue({ rows: [{ id: input().integrationId }] });
    await expect(markProviderIntegrationProviderRevokeAmbiguous({
      organizationId: authority.organizationId,
      integrationId: input().integrationId,
      generation: 4n,
      claimId: "55555555-5555-4555-8555-555555555555",
      now: new Date(),
    })).resolves.toBe(true);
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]?.[0] as SQL)
      .sql.replace(/\s+/g, " ");
    expect(query).toContain('"status" = \'reconnect_required\'');
    expect(query).toContain('"disconnect_phase" = \'provider_revoke_ambiguous\'');
    expect(query).toContain('integration."revocation_claim_id" = $');
    expect(query).toContain("integration.\"disconnect_phase\" = 'provider_revoke_started'");
  });

  it.each([
    ...(["active", "reconnect_required"] as const).flatMap((status) => (
      ([
        "claimed",
        "lease_cleanup_pending",
        "leases_revoked",
        "provider_revoke_started",
        "provider_revoke_ambiguous",
        "provider_revoked",
      ] as const).map((phase) => [status, phase] as const)
    )),
  ])("resumes %s disconnects from the exact %s crash phase", async (status, phase) => {
    const claimId = "55555555-5555-4555-8555-555555555555";
    executeMock.mockResolvedValue({
      rows: [{
        provider: "planetScale",
        generation: 11n,
        claimId,
        phase,
        status,
      }],
    });

    await expect(resumeProviderIntegrationDisconnect({
      authority,
      integrationId: input().integrationId,
    })).resolves.toEqual({
      provider: "planetScale",
      generation: 11n,
      claimId,
      phase,
    });

    const query = new PgDialect().sqlToQuery(
      executeMock.mock.calls[0]?.[0] as SQL,
    ).sql.replace(/\s+/g, " ");
    expect(query).toContain("integration.\"status\" IN ('active', 'reconnect_required')");
    expect(query).toContain(
      'integration."generation" = integration."disconnect_generation"',
    );
    expect(query).toContain('integration."revocation_claim_id" IS NOT NULL');
    expect(query).toContain('integration."disconnect_phase" IN');
  });

  it("keeps the durable mutation inventory centralized", async () => {
    const route = await import("node:fs/promises").then((fs) => fs.readFile(
      new URL("../app/api/v1/workspaces/[workspaceId]/provider-integrations/route.ts", import.meta.url),
      "utf8",
    ));
    const disconnect = await import("node:fs/promises").then((fs) => fs.readFile(
      new URL("../app/api/v1/workspaces/[workspaceId]/provider-integrations/[integrationId]/route.ts", import.meta.url),
      "utf8",
    ));
    const providerHelpers = await import("node:fs/promises").then((fs) => fs.readFile(
      new URL("./provider-integrations/integration.ts", import.meta.url),
      "utf8",
    ));
    expect(PROVIDER_INTEGRATION_DURABLE_MUTATION_ENTRYPOINTS).toEqual([
      "persistProviderIntegration", "claimPlanetScaleCredentialRefresh",
      "markPlanetScaleCredentialRefreshRemoteStarted", "finalizePlanetScaleCredentialRefresh",
      "requirePlanetScaleCredentialReconnect", "claimProviderIntegrationDisconnect",
      "resumeProviderIntegrationDisconnect",
      "markProviderIntegrationDisconnectLeasesRevoked",
      "markProviderIntegrationLeaseCleanupPending",
      "markProviderIntegrationProviderRevokeStarted",
      "markProviderIntegrationProviderRevokeAmbiguous",
      "markProviderIntegrationProviderRevoked",
      "releaseProviderIntegrationDisconnectClaim",
      "planetScaleOAuthCallback", "providerAccessToken", "disconnectProviderIntegration",
    ]);
    expect(route).toContain("persistProviderIntegration(");
    expect(route).not.toContain("db.batch(");
    expect(route).not.toMatch(/db\.(insert|update)\(workspaceProviderIntegration/);
    expect(disconnect).toContain("WITH revoked_integration AS");
    expect(disconnect).toContain("claimProviderIntegrationDisconnect");
    expect(providerHelpers).toContain("generation: integration.generation");
    expect(providerHelpers).toContain("claimPlanetScaleCredentialRefresh");
  });
});
