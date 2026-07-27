import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimRefresh: vi.fn(), finalizeRefresh: vi.fn(), markRefreshRemoteStarted: vi.fn(),
  requireReconnect: vi.fn(), refreshToken: vi.fn(), execute: vi.fn(), activeIntegration: vi.fn(),
  planetDatabases: vi.fn(), planetBranches: vi.fn(), neonBranches: vi.fn(), neonDatabases: vi.fn(),
  gcpInstances: vi.fn(), gcpDatabases: vi.fn(), gcpProjects: vi.fn(), neonProjects: vi.fn(), openCredential: vi.fn(() => ({
    accessToken: "test", refreshToken: "test", expiresAt: "2999-01-01T00:00:00.000Z", scope: "",
    projectId: "sample-project-123", projectNumber: "123456789012", workloadIdentityPoolId: "pool",
    workloadIdentityProviderId: "provider", instanceId: "instance",
    readServiceAccountEmail: "read@sample-project-123.iam.gserviceaccount.com", writeServiceAccountEmail: null,
    dedicatedServiceAccountsConfirmed: true, instanceScopedIamConfirmed: true,
  })),
}));
vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({
  db: {
    execute: mocks.execute,
    query: { workspaceProviderIntegration: { findFirst: mocks.activeIntegration } },
  },
}));
vi.mock("./secret-envelope", () => ({ openProviderCredential: mocks.openCredential, sealProviderCredential: vi.fn() }));
vi.mock("./provider-integration-mutation-store", () => ({
  claimPlanetScaleCredentialRefresh: mocks.claimRefresh,
  finalizePlanetScaleCredentialRefresh: mocks.finalizeRefresh,
  markPlanetScaleCredentialRefreshRemoteStarted: mocks.markRefreshRemoteStarted,
  requirePlanetScaleCredentialReconnect: mocks.requireReconnect,
}));
vi.mock("./providers/planetscale-core", () => ({ missingPlanetScaleManagedScopes: () => [] }));
vi.mock("./providers/gcp-cloud-sql-core", () => ({
  parseGcpCloudSqlCredential: (value: unknown) => value,
  parseGcpCloudSqlResource: (value: unknown) => value,
}));
vi.mock("./providers/neon-core", () => ({ parseNeonResource: (value: unknown) => value }));
vi.mock("./revocation-gates", () => ({
  finalizeManagedLeaseIfUnblocked: vi.fn(), reserveManagedLeaseIfUnblocked: vi.fn(),
  revocationGateLockKey: vi.fn(),
}));
vi.mock("./providers/planetscale", () => ({
  issuePlanetScaleLease: vi.fn(), PlanetScaleRequestError: Error, refreshPlanetScaleToken: mocks.refreshToken,
  revokePlanetScaleAuthorization: vi.fn(), revokePlanetScaleLease: vi.fn(), validatePlanetScaleResource: vi.fn(),
  listPlanetScaleBranches: mocks.planetBranches, listPlanetScaleDatabases: mocks.planetDatabases,
  listPlanetScaleOrganizations: vi.fn(),
}));
vi.mock("./providers/neon", () => ({
  issueNeonLease: vi.fn(), listNeonBranches: mocks.neonBranches, listNeonDatabases: mocks.neonDatabases,
  listNeonProjects: mocks.neonProjects, neonRoleForLease: vi.fn(), revokeNeonLease: vi.fn(), validateNeonResource: vi.fn(),
}));
vi.mock("./providers/gcp-cloud-sql", () => ({
  issueGcpCloudSqlLease: vi.fn(), listGcpCloudSqlDatabases: mocks.gcpDatabases,
  listGcpCloudSqlInstances: mocks.gcpInstances, listGcpProjects: mocks.gcpProjects, validateGcpCloudSqlResource: vi.fn(),
}));

import {
  discoverProviderResources,
  activeProviderIntegration,
  providerAccessToken,
  providerMutationAuthoritySql,
  recordProviderDiscoveryReceipt,
} from "./provider-integrations";

const integration = (provider: "neon" | "gcpCloudSql" | "planetScale") => ({
  id: "integration", organizationId: "org", provider, encryptedCredential: "unused", credentialExpiresAt: null,
  generation: 1n,
  updatedAt: new Date("2026-07-27T00:00:00Z"),
});
const oidc = `${"a".repeat(100)}.${"b".repeat(100)}.${"c".repeat(100)}`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("final provider discovery parent binding", () => {
  it("fails closed for mixed-version active GCP rows without an exact local target", async () => {
    const row = {
      ...integration("gcpCloudSql"),
      localVerificationTarget: null,
    };
    mocks.activeIntegration.mockResolvedValueOnce(row);
    await expect(activeProviderIntegration("org", "integration")).resolves.toBeNull();

    mocks.activeIntegration.mockResolvedValueOnce({
      ...row,
      localVerificationTarget: {
        kind: "gcpCloudSql", projectId: "sample-project-123", instanceId: "instance", token: "no",
      },
    });
    await expect(activeProviderIntegration("org", "integration")).resolves.toBeNull();
  });

  it.each(["neon", "planetScale"] as const)(
    "keeps active %s integrations unaffected by the GCP target gate",
    async (provider) => {
      const row = { ...integration(provider), localVerificationTarget: null };
      mocks.activeIntegration.mockResolvedValueOnce(row);
      await expect(activeProviderIntegration("org", "integration")).resolves.toEqual(row);
    },
  );

  it("builds the final mutation guard with the shared member gate and exact authority", () => {
    const query = new PgDialect().sqlToQuery(providerMutationAuthoritySql({
      organizationId: "org", membershipId: "member", userId: "user", sessionId: "session", role: "admin",
      integration: {
        id: "00000000-0000-4000-8000-000000000001",
        provider: "neon", generation: 7n, claimId: null,
      },
    })).sql.replace(/\s+/g, " ");
    expect(query).toContain("pg_advisory_xact_lock");
    expect(query).toContain('"workspace_control"."session"');
    expect(query).toContain('"workspace_control"."member"');
    expect(query).toContain('"revocation_pending_at" IS NULL');
    expect(query).toContain('"revocation_claim_id" IS NULL');
    expect(query).toContain("'admin', 'owner'");
    expect(query).toContain('"expires_at" > now()');
    expect(query).toContain('"generation" = $');
  });

  it("never lets a current lease use grant widen a shared credential mutation", () => {
    const integration = {
      id: "00000000-0000-4000-8000-000000000001",
      provider: "planetScale",
      generation: 7n,
      claimId: null,
    };
    const managerOnly = new PgDialect().sqlToQuery(providerMutationAuthoritySql({
      organizationId: "org", membershipId: "member", userId: "user", sessionId: "session", role: "viewer",
      requireManager: true,
      integration,
      lease: { connectionId: "connection", connectionRevision: 3, providerResourceId: "resource" },
    })).sql.replace(/\s+/g, " ");
    expect(managerOnly).toContain("'admin', 'owner'");
    expect(managerOnly).not.toContain("'viewer', 'analyst', 'editor', 'admin', 'owner'");
    expect(managerOnly).not.toContain('"workspace_connection_grant"');
    expect(managerOnly).toContain('"expires_at" > now()');
    expect(managerOnly).toContain('"revocation_pending_at" IS NULL');
    expect(managerOnly).toContain('"revocation_claim_id" IS NULL');
    expect(managerOnly).toContain('"generation" = $');

    const leaseUse = new PgDialect().sqlToQuery(providerMutationAuthoritySql({
      organizationId: "org", membershipId: "member", userId: "user", sessionId: "session", role: "viewer",
      integration,
      lease: { connectionId: "connection", connectionRevision: 3, providerResourceId: "resource" },
    })).sql.replace(/\s+/g, " ");
    expect(leaseUse).toContain("'viewer', 'analyst', 'editor', 'admin', 'owner'");
    expect(leaseUse).toContain('"workspace_connection_grant"');
    expect(leaseUse).toContain('"capability" IN (\'use\', \'manage\')');
  });

  it("lets a viewer consume only a still-valid token and stops before provider I/O when refresh needs a manager", async () => {
    const viewerAuthority = {
      organizationId: "org", membershipId: "member", userId: "user", sessionId: "session", role: "viewer" as const,
      lease: { connectionId: "connection", connectionRevision: 3, providerResourceId: "resource" },
    };
    await expect(providerAccessToken(integration("planetScale"), viewerAuthority)).resolves.toBe("test");
    expect(mocks.claimRefresh).not.toHaveBeenCalled();

    mocks.openCredential.mockReturnValueOnce({
      accessToken: "expiring", refreshToken: "refresh", expiresAt: new Date(Date.now() + 60_000).toISOString(), scope: "",
      projectId: "sample-project-123", projectNumber: "123456789012", workloadIdentityPoolId: "pool",
      workloadIdentityProviderId: "provider", instanceId: "instance",
      readServiceAccountEmail: "read@sample-project-123.iam.gserviceaccount.com", writeServiceAccountEmail: null,
      dedicatedServiceAccountsConfirmed: true, instanceScopedIamConfirmed: true,
    });
    mocks.claimRefresh.mockResolvedValueOnce(false);
    await expect(providerAccessToken(integration("planetScale"), viewerAuthority))
      .rejects.toThrow(/current workspace manager or reconnect/);
    expect(mocks.claimRefresh).toHaveBeenCalledWith(expect.objectContaining({
      authority: viewerAuthority,
    }));
    expect(mocks.markRefreshRemoteStarted).not.toHaveBeenCalled();
    expect(mocks.refreshToken).not.toHaveBeenCalled();
    expect(mocks.finalizeRefresh).not.toHaveBeenCalled();
  });

  it("preserves actual Neon and GCP unknown production classification without importing it", async () => {
    const neon = { id: "project", value: "project", name: "project", ready: true, production: "unknown" as const };
    const gcp = { id: "sample-project-123", value: "sample-project-123", name: "sample-project-123", ready: true, production: "unknown" as const };
    mocks.neonProjects.mockResolvedValue([neon]);
    mocks.gcpProjects.mockResolvedValue([gcp]);
    await expect(discoverProviderResources({ integration: integration("neon"), kind: "projects", selection: {} }))
      .resolves.toEqual([neon]);
    await expect(discoverProviderResources({ integration: integration("gcpCloudSql"), kind: "projects", selection: {}, oidcToken: oidc }))
      .resolves.toEqual([gcp]);
  });

  it("rejects stale/non-ready Neon branches before it lists databases", async () => {
    mocks.neonBranches.mockResolvedValue([{ value: "branch", ready: false, production: false }]);
    await expect(discoverProviderResources({ integration: integration("neon"), kind: "databases", selection: { project: "p", branch: "branch" } }))
      .rejects.toMatchObject({ status: 409 });
    expect(mocks.neonDatabases).not.toHaveBeenCalled();
  });

  it("rejects production and engine-mismatched GCP instances from crafted final URLs", async () => {
    mocks.gcpInstances.mockResolvedValue([{ value: "instance", ready: true, production: true, kind: "postgres" }]);
    await expect(discoverProviderResources({ integration: integration("gcpCloudSql"), kind: "databases", selection: { project: "sample-project-123", instance: "instance", engine: "postgres" }, oidcToken: oidc }))
      .rejects.toMatchObject({ status: 409 });
    mocks.gcpInstances.mockResolvedValue([{ value: "instance", ready: true, production: false, kind: "postgres" }]);
    await expect(discoverProviderResources({ integration: integration("gcpCloudSql"), kind: "databases", selection: { project: "sample-project-123", instance: "instance", engine: "mysql" }, oidcToken: oidc }))
      .rejects.toMatchObject({ status: 409 });
    expect(mocks.gcpDatabases).not.toHaveBeenCalled();
  });

  it("fails closed when final parent production markers are omitted or unknown", async () => {
    mocks.neonBranches.mockResolvedValue([{ value: "branch", ready: true }]);
    await expect(discoverProviderResources({ integration: integration("neon"), kind: "databases", selection: { project: "p", branch: "branch" } }))
      .rejects.toMatchObject({ status: 409 });
    mocks.gcpInstances.mockResolvedValue([{ value: "instance", ready: true, production: "unknown", kind: "postgres" }]);
    await expect(discoverProviderResources({ integration: integration("gcpCloudSql"), kind: "databases", selection: { project: "sample-project-123", instance: "instance" }, oidcToken: oidc }))
      .rejects.toMatchObject({ status: 409 });
    expect(mocks.neonDatabases).not.toHaveBeenCalled();
    expect(mocks.gcpDatabases).not.toHaveBeenCalled();
  });

  it("binds a PlanetScale branch to the re-fetched database engine", async () => {
    mocks.planetDatabases.mockResolvedValue([{ value: "db", kind: "mysql" }]);
    mocks.planetBranches.mockResolvedValue([{ id: "b", value: "branch", name: "branch", ready: true, production: false }]);
    await expect(discoverProviderResources({ integration: integration("planetScale"), kind: "branches", selection: { organization: "org", database: "db" } }))
      .resolves.toEqual([{ id: "b", value: "branch", name: "branch", ready: true, production: false, kind: "mysql" }]);
    await expect(discoverProviderResources({ integration: integration("planetScale"), kind: "branches", selection: { organization: "org", database: "db", engine: "postgres" } }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("keeps PlanetScale listing from entering token refresh state by construction", async () => {
    mocks.openCredential.mockReturnValueOnce({
      accessToken: "expiring",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scope: "",
      projectId: "sample-project-123",
      projectNumber: "123456789012",
      workloadIdentityPoolId: "pool",
      workloadIdentityProviderId: "provider",
      instanceId: "instance",
      readServiceAccountEmail: "read@sample-project-123.iam.gserviceaccount.com",
      writeServiceAccountEmail: null,
      dedicatedServiceAccountsConfirmed: true,
      instanceScopedIamConfirmed: true,
    });
    await expect(discoverProviderResources({
      integration: integration("planetScale"),
      kind: "organizations",
      selection: {},
    })).rejects.toThrow();
    expect(mocks.planetDatabases).not.toHaveBeenCalled();
    expect(mocks.planetBranches).not.toHaveBeenCalled();
    expect(mocks.claimRefresh).not.toHaveBeenCalled();
    expect(mocks.markRefreshRemoteStarted).not.toHaveBeenCalled();
    expect(mocks.refreshToken).not.toHaveBeenCalled();
    expect(mocks.finalizeRefresh).not.toHaveBeenCalled();
    expect(mocks.requireReconnect).not.toHaveBeenCalled();
  });

  it("rebuilds the discovery DTO and strips unexpected provider fields", async () => {
    mocks.neonProjects.mockResolvedValue([{
      id: "project",
      value: "project",
      name: "Project",
      ready: true,
      production: "unknown",
      token: "must-not-leak",
      password: "must-not-leak",
      endpoint: "internal.example",
    }]);
    await expect(discoverProviderResources({
      integration: integration("neon"),
      kind: "projects",
      selection: {},
    })).resolves.toEqual([{
      id: "project",
      value: "project",
      name: "Project",
      ready: true,
      production: "unknown",
    }]);
  });

  it("normalizes Neon timestamp text for exact proof replay without another resource write", async () => {
    const receiptId = "33333333-3333-4333-8333-333333333333";
    const expiresAt = new Date(Date.now() + 4 * 60_000);
    mocks.execute.mockResolvedValue({
      rows: [{ id: receiptId, expiresAt: expiresAt.toISOString() }],
    });
    const input: Parameters<typeof recordProviderDiscoveryReceipt>[0] = {
      organizationId: "org",
      integrationId: "22222222-2222-4222-8222-222222222222",
      memberId: "member",
      userId: "user",
      sessionId: "session",
      role: "admin",
      provider: "neon",
      integrationGeneration: 7n,
      receiptId,
      expiresAt,
      projection: {
        fingerprint: "a".repeat(64),
        resource: {
          project: "project",
          branch: "branch",
          database: "app",
          engine: "postgres",
          schemas: ["public"],
        },
        metadata: {
          project: "project",
          branch: "branch",
          database: "app",
          engine: "postgres",
        },
        capabilities: {
          discover: true,
          importReadOnly: true,
          managedLease: true,
          write: false,
        },
        host: "neon.managed.invalid",
        port: 5432,
        database: "app",
        engine: "postgres",
        sslmode: "verify-full",
      },
    };
    await expect(recordProviderDiscoveryReceipt(input)).resolves.toEqual({ id: receiptId, expiresAt });
    const statement = mocks.execute.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(statement);
    expect(query.sql).toContain("existing_receipt AS MATERIALIZED");
    expect(query.sql).toContain('integration."refresh_phase" = \'idle\'');
    expect(query.sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM existing_receipt)");
    expect(query.sql).toContain('ON CONFLICT ("id") DO UPDATE');
    expect(query.sql).toContain('SET "expires_at" = existing."expires_at"');
    for (const field of [
      "organization_id",
      "resource_id",
      "integration_id",
      "integration_generation",
      "member_id",
      "user_id",
      "session_id",
      "expires_at",
    ]) {
      expect(query.sql).toContain(
        `existing."${field}" = EXCLUDED."${field}"`,
      );
    }
    expect(query.sql).toContain('SELECT "id", "expiresAt" FROM existing_receipt');
    expect(query.params).toContain(receiptId);

    mocks.execute.mockResolvedValueOnce({
      rows: [{ id: receiptId, expiresAt: "not-a-timestamp" }],
    });
    await expect(recordProviderDiscoveryReceipt(input)).resolves.toBeNull();
    mocks.execute.mockResolvedValueOnce({
      rows: [{ id: receiptId, expiresAt: null }],
    });
    await expect(recordProviderDiscoveryReceipt(input)).resolves.toBeNull();
    mocks.execute.mockResolvedValueOnce({
      rows: [{ id: "not-a-receipt-id", expiresAt: expiresAt.toISOString() }],
    });
    await expect(recordProviderDiscoveryReceipt(input)).resolves.toBeNull();
  });
});
