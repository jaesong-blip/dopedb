// Route-level races: provider I/O may finish, but only the centralized store
// can turn it into durable state or an integration response.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  gcpCloudSqlIntegrationIdentity,
  parseGcpCloudSqlCredential,
} from "../../../../../../lib/providers/gcp-cloud-sql-core";

const {
  authorizeWorkspaceMock,
  claimMock,
  findIntegrationMock,
  inspectNeonCredentialMock,
  persistMock,
  releaseMock,
  revokeLeasesMock,
  selectResults,
  validateGcpMock,
} = vi.hoisted(() => ({
  authorizeWorkspaceMock: vi.fn(),
  claimMock: vi.fn(),
  findIntegrationMock: vi.fn(),
  inspectNeonCredentialMock: vi.fn(),
  persistMock: vi.fn(),
  releaseMock: vi.fn(),
  revokeLeasesMock: vi.fn(),
  selectResults: [] as unknown[][],
  validateGcpMock: vi.fn(),
}));

function selectBuilder() {
  const builder = { from: vi.fn(), innerJoin: vi.fn(), where: vi.fn() };
  builder.from.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.where.mockImplementation(async () => selectResults.shift() ?? []);
  return builder;
}

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../lib/db", () => ({
  db: {
    select: vi.fn(() => selectBuilder()),
    query: { workspaceProviderIntegration: { findFirst: findIntegrationMock } },
  },
}));
vi.mock("../../../../../../lib/env", () => ({
  env: { appOrigin: () => "https://app.example" },
}));
vi.mock("../../../../../../lib/provider-integrations", () => ({
  parseManagedProviderResource: vi.fn(),
  revokeActiveLeases: revokeLeasesMock,
}));
vi.mock("../../../../../../lib/provider-integration-mutation-store", () => ({
  persistProviderIntegration: persistMock,
}));
vi.mock("../../../../../../lib/revocation-gates", () => ({
  claimRevocationGate: claimMock,
  releaseRevocationGateClaim: releaseMock,
}));
vi.mock("../../../../../../lib/providers/planetscale", () => ({
  isPlanetScaleConfigured: () => false,
  planetScaleAuthorizationUrl: vi.fn(),
  PlanetScaleRequestError: class PlanetScaleRequestError extends Error {},
}));
vi.mock("../../../../../../lib/providers/neon", () => ({
  inspectNeonCredential: inspectNeonCredentialMock,
}));
vi.mock("../../../../../../lib/providers/gcp-cloud-sql", () => ({
  validateGcpCloudSqlCredential: validateGcpMock,
  vercelOidcToken: () => "oidc-token",
}));
vi.mock("../../../../../../lib/secret-envelope", () => ({
  openProviderCredential: vi.fn(),
  sealProviderCredential: () => "sealed",
}));
vi.mock("../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspace: authorizeWorkspaceMock,
}));

import { GET, POST } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const integrationId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ workspaceId }) };
const configuration = {
  projectId: "sample-project-123", projectNumber: "123456789012",
  workloadIdentityPoolId: "vercel-prod", workloadIdentityProviderId: "dopedb-app",
  instanceId: "prod-db",
  readServiceAccountEmail: "dopedb-read@sample-project-123.iam.gserviceaccount.com",
  writeServiceAccountEmail: "dopedb-write@sample-project-123.iam.gserviceaccount.com",
  dedicatedServiceAccountsConfirmed: true, instanceScopedIamConfirmed: true,
};
const identity = gcpCloudSqlIntegrationIdentity(
  parseGcpCloudSqlCredential(configuration),
);

function request(provider: "gcpCloudSql" | "neon" = "gcpCloudSql") {
  return new Request(`https://app.example/api/v1/workspaces/${workspaceId}/provider-integrations`, {
    method: "POST",
    headers: { origin: "https://app.example", "content-type": "application/json" },
    body: JSON.stringify(provider === "neon" ? {
      provider, configuration: { apiKey: "neon-api-key-with-sufficient-length" },
    } : { provider, configuration }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResults.splice(0);
  authorizeWorkspaceMock.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-user" }, session: { id: "session-id" } },
    membership: { id: "member-id" }, role: "admin",
  });
  validateGcpMock.mockResolvedValue(undefined);
  revokeLeasesMock.mockResolvedValue({ revoked: 0, deferred: 0 });
  releaseMock.mockResolvedValue(true);
  findIntegrationMock.mockResolvedValue(undefined);
  inspectNeonCredentialMock.mockResolvedValue({
    displayName: "Neon · Example", externalAccountId: "neon:v2:user:subject:scope",
    projectCount: 1, scopeFingerprint: "0123456789abcdef0123456789abcdef",
  });
  persistMock.mockResolvedValue({ ok: true, id: integrationId });
});

describe("provider integration atomic mutation boundary", () => {
  it("exposes an immediately non-issuable refresh as reconnect-required UX state", async () => {
    selectResults.push([{
      id: integrationId,
      provider: "planetScale",
      status: "reconnect_required",
      generation: 9_007_199_254_740_993n,
      displayName: "PlanetScale · account",
      credentialExpiresAt: null,
      grantedScope: "read",
      createdAt: new Date(),
      updatedAt: new Date(),
    }], []);

    const response = await GET(
      new Request(
        `https://app.example/api/v1/workspaces/${workspaceId}/provider-integrations`,
      ),
      context,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      integrations: [{
        id: integrationId,
        status: "reconnect_required",
        generation: "9007199254740993",
        reconnectRequired: true,
      }],
    });
    expect(body.integrations[0]).not.toHaveProperty("encryptedCredential");
    expect(body.integrations[0]).not.toHaveProperty("credential");
  });

  it("rejects a service account already claimed by another workspace before persistence", async () => {
    selectResults.push([{
      principalFingerprint: identity.readPrincipal, targetFingerprint: identity.instance,
      integrationId, organizationId: "99999999-9999-4999-8999-999999999999",
      provider: "gcpCloudSql", status: "active", revokedAt: null,
      revocationPendingAt: null, updatedAt: new Date(),
    }]);

    expect((await POST(request(), context)).status).toBe(409);
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("returns no integration or provider credential when create authority disappears after I/O", async () => {
    selectResults.push([], []);
    persistMock.mockResolvedValue({ ok: false });

    const response = await POST(request(), context);

    expect(validateGcpMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Workspace access denied" });
    expect(persistMock).toHaveBeenCalledWith(expect.objectContaining({
      existing: undefined,
      localVerificationTarget: {
        kind: "gcpCloudSql",
        projectId: configuration.projectId,
        instanceId: configuration.instanceId,
      },
      principalClaims: expect.arrayContaining([
        expect.objectContaining({ principalFingerprint: identity.readPrincipal }),
      ]),
    }));
  });

  it("stores a verified GCP local target only through the authority-bound mutation", async () => {
    selectResults.push([], []);

    const response = await POST(request(), context);

    expect(response.status).toBe(201);
    expect(validateGcpMock).toHaveBeenCalledBefore(persistMock);
    expect(persistMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: "gcpCloudSql",
      localVerificationTarget: {
        kind: "gcpCloudSql",
        projectId: configuration.projectId,
        instanceId: configuration.instanceId,
      },
    }));
    expect(JSON.stringify(await response.json())).not.toMatch(/projectId|instanceId|credential|token/i);
  });

  it("releases the claimed gate and writes no audit/secret response after reconnect demotion", async () => {
    const existing = {
      id: integrationId, status: "active", revokedAt: null,
      revocationPendingAt: null, updatedAt: new Date("2026-07-23T00:00:00Z"),
    };
    selectResults.push([{
      principalFingerprint: identity.readPrincipal, targetFingerprint: identity.instance,
      integrationId, organizationId: workspaceId, provider: "gcpCloudSql", ...existing,
    }], [existing]);
    const claim = {
      kind: "integration", organizationId: workspaceId, integrationId,
      claimId: "33333333-3333-4333-8333-333333333333", claimedAt: new Date(),
      pendingAt: new Date(), firstPending: true,
    };
    claimMock.mockResolvedValue(claim);
    persistMock.mockResolvedValue({ ok: false });

    const response = await POST(request(), context);

    expect(revokeLeasesMock).toHaveBeenCalledWith({ organizationId: workspaceId, integrationId });
    expect(releaseMock).toHaveBeenCalledWith(claim);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Provider access changed concurrently. Retry connecting.",
    });
  });

  it("keeps idempotent reconnects typed and returns only secretless integration metadata", async () => {
    const existing = {
      id: integrationId, status: "active", revokedAt: null,
      revocationPendingAt: null, updatedAt: new Date("2026-07-23T00:00:00Z"),
    };
    findIntegrationMock.mockResolvedValue(existing);
    claimMock.mockResolvedValue({
      kind: "integration", organizationId: workspaceId, integrationId,
      claimId: "33333333-3333-4333-8333-333333333333", claimedAt: new Date(),
      pendingAt: new Date(), firstPending: true,
    });
    const response = await POST(request("neon"), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ integration: {
      id: integrationId, provider: "neon", displayName: "Neon · Example",
    } });
  });
});
