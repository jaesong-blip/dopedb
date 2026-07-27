import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authorizeWorkspaceMock,
  claimMock,
  executeMock,
  integrationForRevocationMock,
  leasesRevokedMock,
  leaseCleanupPendingMock,
  revokeAmbiguousMock,
  revokeStartedMock,
  providerRevokedMock,
  resumeMock,
  releaseMock,
  revokeAuthorizationMock,
  revokeLeasesMock,
} = vi.hoisted(() => ({
  authorizeWorkspaceMock: vi.fn(),
  claimMock: vi.fn(),
  executeMock: vi.fn(),
  integrationForRevocationMock: vi.fn(),
  leasesRevokedMock: vi.fn(),
  leaseCleanupPendingMock: vi.fn(),
  revokeAmbiguousMock: vi.fn(),
  revokeStartedMock: vi.fn(),
  providerRevokedMock: vi.fn(),
  resumeMock: vi.fn(),
  releaseMock: vi.fn(),
  revokeAuthorizationMock: vi.fn(),
  revokeLeasesMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../../lib/db", () => ({
  db: { execute: executeMock },
}));
vi.mock("../../../../../../../lib/env", () => ({
  env: { appOrigin: () => "https://app.example" },
}));
vi.mock("../../../../../../../lib/provider-integrations", () => ({
  providerIntegrationForRevocation: integrationForRevocationMock,
  providerMutationAuthoritySql: () => sql`authority_guard`,
  revokeActiveLeases: revokeLeasesMock,
  revokeProviderAuthorization: revokeAuthorizationMock,
}));
vi.mock("../../../../../../../lib/provider-integration-mutation-store", () => ({
  claimProviderIntegrationDisconnect: claimMock,
  markProviderIntegrationDisconnectLeasesRevoked: leasesRevokedMock,
  markProviderIntegrationLeaseCleanupPending: leaseCleanupPendingMock,
  markProviderIntegrationProviderRevokeAmbiguous: revokeAmbiguousMock,
  markProviderIntegrationProviderRevokeStarted: revokeStartedMock,
  markProviderIntegrationProviderRevoked: providerRevokedMock,
  resumeProviderIntegrationDisconnect: resumeMock,
  releaseProviderIntegrationDisconnectClaim: releaseMock,
}));
vi.mock("../../../../../../../lib/secret-envelope", () => ({
  sealProviderCredential: () => "scrubbed",
}));
vi.mock("../../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspace: authorizeWorkspaceMock,
}));

import { DELETE } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const integrationId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ workspaceId, integrationId }) };
const claim = {
  kind: "integration",
  organizationId: workspaceId,
  integrationId,
  claimId: "33333333-3333-4333-8333-333333333333",
  claimedAt: new Date("2026-07-23T00:00:00Z"),
  pendingAt: new Date("2026-07-23T00:00:00Z"),
  firstPending: true,
};
const integration = {
  id: integrationId,
  organizationId: workspaceId,
  provider: "neon",
  encryptedCredential: "sealed",
  credentialExpiresAt: null,
};

function request() {
  return new Request(
    `https://app.example/api/v1/workspaces/${workspaceId}`
      + `/provider-integrations/${integrationId}`,
    { method: "DELETE", headers: { origin: "https://app.example" } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeWorkspaceMock.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-user" }, session: { id: "session-id" } },
    membership: { id: "member-id" },
    role: "admin",
  });
  claimMock.mockResolvedValue({ provider: "neon", generation: 7n });
  integrationForRevocationMock.mockResolvedValue(integration);
  releaseMock.mockResolvedValue(true);
  leasesRevokedMock.mockResolvedValue(true);
  leaseCleanupPendingMock.mockResolvedValue(true);
  revokeAmbiguousMock.mockResolvedValue(true);
  revokeStartedMock.mockResolvedValue(true);
  providerRevokedMock.mockResolvedValue(true);
  resumeMock.mockResolvedValue(null);
  revokeLeasesMock.mockResolvedValue({ revoked: 2, deferred: 0 });
  revokeAuthorizationMock.mockResolvedValue(undefined);
  executeMock.mockResolvedValue({ rows: [{ id: integrationId }] });
});

describe("provider disconnect authority gate", () => {
  it("rejects a concurrent claimant before reading provider credentials", async () => {
  claimMock.mockResolvedValue(null);

    const response = await DELETE(request(), context);

    expect(response.status).toBe(409);
    expect(revokeLeasesMock).not.toHaveBeenCalled();
    expect(revokeAuthorizationMock).not.toHaveBeenCalled();
  });

  it("keeps the integration pending when a live lease cannot be revoked", async () => {
    revokeLeasesMock.mockResolvedValue({ revoked: 1, deferred: 1 });

    const response = await DELETE(request(), context);

    expect(response.status).toBe(409);
    expect(leaseCleanupPendingMock).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: workspaceId, integrationId, generation: 7n,
    }));
    expect(revokeAmbiguousMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(revokeAuthorizationMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("atomically CASes integration revocation, detach, and audit", async () => {
    const response = await DELETE(request(), context);

    expect(response.status).toBe(204);
    const statement = executeMock.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(statement).sql.replace(/\s+/g, " ");
    expect(query).toContain("WITH revoked_integration AS");
    expect(query).toContain("authority_guard");
    expect(query).toContain("\"revocation_claim_id\" = $");
    expect(query).toContain("detached_connections AS");
    expect(query).toContain('"provider_integration_id" = NULL');
    expect(query).toContain('"provider_resource" = NULL');
    expect(query).toContain('"provider_resource_id" = NULL');
    expect(query).toContain("deleted_principal_claims AS");
    expect(query).toContain(
      "DELETE FROM \"workspace_control\".\"workspace_provider_principal_claim\"",
    );
    expect(query).toContain("audit_event AS");
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("does not finalize a post-I/O disconnect when final authority is gone", async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });

    const response = await DELETE(request(), context);

    expect(response.status).toBe(409);
    const statement = executeMock.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(statement).sql.replace(/\s+/g, " ");
    expect(query).toContain("authority_guard");
    expect(query).toContain('integration."disconnect_phase" = \'provider_revoked\'');
  });

  it("resumes provider_revoked with the original fence and finalizes without another provider call", async () => {
    claimMock.mockResolvedValue(null);
    resumeMock.mockResolvedValue({
      provider: "neon", generation: 7n, claimId: claim.claimId, phase: "provider_revoked",
    });

    const response = await DELETE(request(), context);

    expect(response.status).toBe(204);
    expect(revokeLeasesMock).not.toHaveBeenCalled();
    expect(revokeAuthorizationMock).not.toHaveBeenCalled();
    const statement = executeMock.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(statement).sql.replace(/\s+/g, " ");
    expect(query).toContain('"disconnect_phase" = \'provider_revoked\'');
  });

  it("retries only the exact durable lease-cleanup phase after a worker crash", async () => {
    claimMock.mockResolvedValue(null);
    resumeMock.mockResolvedValue({
      provider: "neon", generation: 7n, claimId: claim.claimId, phase: "lease_cleanup_pending",
    });

    const response = await DELETE(request(), context);

    expect(response.status).toBe(204);
    expect(revokeLeasesMock).toHaveBeenCalledWith({ organizationId: workspaceId, integrationId });
    expect(leasesRevokedMock).toHaveBeenCalledWith(expect.objectContaining({ claimId: claim.claimId }));
  });

  it("resumes leases_revoked at provider revoke start without repeating lease cleanup", async () => {
    claimMock.mockResolvedValue(null);
    resumeMock.mockResolvedValue({
      provider: "neon", generation: 7n, claimId: claim.claimId, phase: "leases_revoked",
    });

    const response = await DELETE(request(), context);

    expect(response.status).toBe(204);
    expect(revokeLeasesMock).not.toHaveBeenCalled();
    expect(revokeStartedMock).toHaveBeenCalledWith(expect.objectContaining({ claimId: claim.claimId }));
    expect(revokeAuthorizationMock).toHaveBeenCalledWith(integration);
  });

  it("turns a resumed PlanetScale provider_revoke_started crash into explicit ambiguity instead of replaying revoke", async () => {
    claimMock.mockResolvedValue(null);
    integrationForRevocationMock.mockResolvedValue({ ...integration, provider: "planetScale" });
    resumeMock.mockResolvedValue({
      provider: "planetScale", generation: 7n, claimId: claim.claimId, phase: "provider_revoke_started",
    });

    const response = await DELETE(request(), context);

    expect(response.status).toBe(409);
    expect(revokeAuthorizationMock).not.toHaveBeenCalled();
    expect(revokeAmbiguousMock).toHaveBeenCalledWith(expect.objectContaining({
      claimId: claim.claimId, generation: 7n,
    }));
  });
});
