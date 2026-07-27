import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authorizeWorkspaceMock,
  claimRevocationGateMock,
  clearRevocationGateMock,
  connectionFindFirstMock,
  executeMock,
  releaseRevocationGateClaimMock,
  revokeActiveLeasesMock,
} = vi.hoisted(() => {
  return {
    authorizeWorkspaceMock: vi.fn(),
    claimRevocationGateMock: vi.fn(),
    clearRevocationGateMock: vi.fn(),
    connectionFindFirstMock: vi.fn(),
    executeMock: vi.fn(),
    releaseRevocationGateClaimMock: vi.fn(),
    revokeActiveLeasesMock: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../../../lib/db", () => ({
  db: {
    execute: executeMock,
    query: {
      workspaceConnection: { findFirst: connectionFindFirstMock },
    },
  },
}));
vi.mock("../../../../../../../../lib/env", () => ({
  env: { appOrigin: () => "https://app.example" },
}));
vi.mock("../../../../../../../../lib/provider-integrations", () => ({
  revokeActiveLeases: revokeActiveLeasesMock,
}));
vi.mock("../../../../../../../../lib/revocation-gates", () => ({
  claimRevocationGate: claimRevocationGateMock,
  clearRevocationGate: clearRevocationGateMock,
  releaseRevocationGateClaim: releaseRevocationGateClaimMock,
  revocationGateLockKey: vi.fn((target: {
    kind: string;
    organizationId: string;
    connectionId?: string;
    memberId?: string;
  }) => `${target.kind}:${target.organizationId}:${
    target.connectionId ?? target.memberId
  }`),
}));
vi.mock("../../../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspace: authorizeWorkspaceMock,
}));

import { PUT } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const integrationId = "33333333-3333-4333-8333-333333333333";
const claimId = "44444444-4444-4444-8444-444444444444";
const context = { params: Promise.resolve({ workspaceId, connectionId }) };
const claim = {
  kind: "connection" as const,
  organizationId: workspaceId,
  connectionId,
  claimId,
  claimedAt: new Date("2026-07-23T14:00:00.000Z"),
  pendingAt: new Date("2026-07-23T14:00:00.000Z"),
  firstPending: true,
  connectionRevision: 8,
};
const connection = {
  id: connectionId,
  organizationId: workspaceId,
  name: "Production",
  engine: "postgres",
  provider: "neon",
  driverId: null,
  host: "db.example.test",
  port: 5432,
  databaseName: "app",
  sslmode: "verify-full",
  readonlyDefault: true,
  allowWrites: false,
  credentialMode: "managed",
  providerIntegrationId: integrationId,
  providerResource: {
    project: "project-id",
    branch: "branch-id",
    database: "app",
    engine: "postgres",
    schemas: ["public"],
  },
  providerResourceId: "55555555-5555-4555-8555-555555555555",
  environment: "prod",
  schemaGroup: null,
  revision: 7,
  createdByUserId: "admin-user",
  createdAt: new Date("2026-07-20T00:00:00.000Z"),
  updatedAt: new Date("2026-07-20T00:00:00.000Z"),
  deletedAt: null,
  revocationPendingAt: null,
  revocationClaimedAt: null,
  revocationClaimId: null,
};

function mutationRequest(body: unknown) {
  return new Request(
    `https://app.example/api/v1/workspaces/${workspaceId}/connections/${connectionId}/managed-access`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example",
      },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeWorkspaceMock.mockResolvedValue({
    ok: true,
    session: { session: { id: "session-id" }, user: { id: "admin-user" } },
    membership: { id: "member-id" },
    role: "admin",
    accessMode: "manage",
  });
  connectionFindFirstMock.mockResolvedValue(connection);
  claimRevocationGateMock.mockResolvedValue(claim);
  clearRevocationGateMock.mockResolvedValue(true);
  releaseRevocationGateClaimMock.mockResolvedValue(true);
  revokeActiveLeasesMock.mockResolvedValue({ revoked: 1, deferred: 0 });
  executeMock.mockResolvedValue({
    rows: [{ ...connection, credentialMode: "member_local", contentRevision: 1, updatedAt: new Date() }],
  });
});

describe("managed access revocation gate", () => {
  it("returns 409 without revoking when another mutation owns the connection gate", async () => {
    claimRevocationGateMock.mockResolvedValue(null);

    const response = await PUT(
      mutationRequest({ mode: "member_local" }),
      context,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Another connection access change is already in progress",
    });
    expect(revokeActiveLeasesMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("rejects a claim that does not follow the validated connection revision", async () => {
    claimRevocationGateMock.mockResolvedValue({
      ...claim,
      connectionRevision: 10,
    });

    const response = await PUT(
      mutationRequest({ mode: "member_local" }),
      context,
    );

    expect(response.status).toBe(409);
    expect(clearRevocationGateMock).toHaveBeenCalledWith(
      expect.objectContaining({ connectionRevision: 10 }),
    );
    expect(releaseRevocationGateClaimMock).not.toHaveBeenCalled();
    expect(revokeActiveLeasesMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("releases only a stale takeover claim on a revision mismatch", async () => {
    claimRevocationGateMock.mockResolvedValue({
      ...claim,
      firstPending: false,
      connectionRevision: 10,
    });

    const response = await PUT(
      mutationRequest({ mode: "member_local" }),
      context,
    );

    expect(response.status).toBe(409);
    expect(releaseRevocationGateClaimMock).toHaveBeenCalledWith(
      expect.objectContaining({
        firstPending: false,
        connectionRevision: 10,
      }),
    );
    expect(clearRevocationGateMock).not.toHaveBeenCalled();
    expect(revokeActiveLeasesMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("releases the exact claim and returns 409 when revocation is deferred", async () => {
    revokeActiveLeasesMock.mockResolvedValue({ revoked: 0, deferred: 1 });

    const response = await PUT(
      mutationRequest({ mode: "member_local" }),
      context,
    );

    expect(response.status).toBe(409);
    expect(releaseRevocationGateClaimMock).toHaveBeenCalledOnce();
    expect(releaseRevocationGateClaimMock).toHaveBeenCalledWith(claim);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("retires raw managed selectors before any provider or revocation operation", async () => {
    const response = await PUT(
      mutationRequest({
        mode: "managed",
        integrationId,
        resource: {
          engine: "postgres",
          project: "project-id",
          branch: "branch-id",
          database: "app",
        },
      }),
      context,
    );

    expect(response.status).toBe(400);
    expect(claimRevocationGateMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("preserves the canonical imported provider links while changing only the mode", async () => {
    const response = await PUT(
      mutationRequest({ mode: "member_local" }),
      context,
    );

    expect(response.status).toBe(200);
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]![0] as SQL).sql
      .replace(/\s+/g, " ");
    for (const fragment of [
      'SET "credential_mode" = \'member_local\'',
      'connection."provider_integration_id"',
      'connection."provider_resource_id"',
      'connection."provider_resource" = resource."resource"',
      'imported."connection_id" = connection."id"',
      'imported."request_hash" = encode(digest(',
      "'integrationGeneration', integration.\"generation\"::text",
      'session."expires_at" > now()',
      'member."revocation_pending_at" IS NULL',
      'grant."capability" = \'manage\'',
      'integration."status" = \'active\'',
      'integration."refresh_phase" = \'idle\'',
      'resource."redacted_metadata" -> \'production\' = \'false\'::jsonb',
      'resource."capability_manifest" -> \'importReadOnly\' = \'true\'::jsonb',
      'resource."capability_manifest" -> \'write\' = \'false\'::jsonb',
      "'providerLinkPreserved', TRUE",
    ]) expect(query).toContain(fragment);
    expect(query).not.toContain('"provider_integration_id" = NULL');
    expect(query).not.toContain('"provider_resource_id" = NULL');
  });

  it("fails closed before the revocation gate for a generic, writable, or linkless connection", async () => {
    connectionFindFirstMock.mockResolvedValueOnce({
      ...connection,
      allowWrites: true,
    });

    const response = await PUT(mutationRequest({ mode: "member_local" }), context);

    expect(response.status).toBe(409);
    expect(claimRevocationGateMock).not.toHaveBeenCalled();
    expect(revokeActiveLeasesMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("requires the same canonical links even for an idempotent member-local request", async () => {
    connectionFindFirstMock.mockResolvedValueOnce({
      ...connection,
      credentialMode: "member_local",
      providerResource: null,
    });

    const response = await PUT(mutationRequest({ mode: "member_local" }), context);

    expect(response.status).toBe(409);
    expect(claimRevocationGateMock).not.toHaveBeenCalled();
  });

  it("fails closed after lease revocation when a session, grant, generation, or provider policy recheck is stale", async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });

    const response = await PUT(mutationRequest({ mode: "member_local" }), context);

    expect(response.status).toBe(409);
    expect(revokeActiveLeasesMock).toHaveBeenCalledOnce();
    expect(releaseRevocationGateClaimMock).toHaveBeenCalledWith(claim);
  });
});
