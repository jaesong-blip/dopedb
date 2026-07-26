import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authorizationRows,
  authorizeWorkspaceConnectionMock,
  batchMock,
  claimMock,
  clearMock,
  commitMock,
  connectionFindMock,
  conflictMock,
  insertMock,
  versionFindMock,
  releaseMock,
  revokeMock,
  updateSetMock,
} = vi.hoisted(() => {
  const updateReturningMock = vi.fn(() => ({ kind: "connection-update" }));
  const updateWhereMock = vi.fn(() => ({ returning: updateReturningMock }));
  return {
    authorizationRows: [] as unknown[],
    authorizeWorkspaceConnectionMock: vi.fn(),
    batchMock: vi.fn(),
    claimMock: vi.fn(),
    clearMock: vi.fn(),
    commitMock: vi.fn(),
    connectionFindMock: vi.fn(),
    conflictMock: vi.fn(),
    insertMock: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => ({ kind: "insert" })) })),
    })),
    versionFindMock: vi.fn(),
    releaseMock: vi.fn(),
    revokeMock: vi.fn(),
    updateSetMock: vi.fn(() => ({ where: updateWhereMock })),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../../lib/db", () => ({
  db: {
    batch: batchMock,
    execute: vi.fn(async () => ({
      rows: [{ conflictId: "44444444-4444-4444-8444-444444444444" }],
    })),
    insert: insertMock,
    query: {
      workspaceConnection: { findFirst: connectionFindMock },
      workspaceResourceVersion: { findFirst: versionFindMock },
    },
    select: vi.fn(() => {
      const builder = {
        from: vi.fn(),
        leftJoin: vi.fn(),
        where: vi.fn(),
        limit: vi.fn(async () => authorizationRows),
      };
      builder.from.mockReturnValue(builder);
      builder.leftJoin.mockReturnValue(builder);
      builder.where.mockReturnValue(builder);
      return builder;
    }),
    update: vi.fn(() => ({ set: updateSetMock })),
  },
}));
vi.mock("../../../../../../../lib/env", () => ({
  env: { appOrigin: () => "https://app.example" },
}));
vi.mock("../../../../../../../lib/provider-integrations", () => ({
  revokeActiveLeases: revokeMock,
}));
vi.mock("../../../../../../../lib/revocation-gates", () => ({
  claimRevocationGate: claimMock,
  clearRevocationGate: clearMock,
  releaseRevocationGateClaim: releaseMock,
}));
vi.mock("../../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspaceConnection: authorizeWorkspaceConnectionMock,
}));
vi.mock("../../../../../../../lib/workspace-versioning-store", () => ({
  commitConnectionMutation: commitMock,
  conflictConnectionCandidate: conflictMock,
}));

import { DELETE, PATCH, POST } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ workspaceId, connectionId }) };
const claim = {
  kind: "connection",
  organizationId: workspaceId,
  connectionId,
  claimId: "33333333-3333-4333-8333-333333333333",
  claimedAt: new Date("2026-07-23T00:00:00Z"),
  pendingAt: new Date("2026-07-23T00:00:00Z"),
  firstPending: true,
  connectionRevision: 2,
};

function request(method: "PATCH" | "DELETE") {
  return new Request(
    `https://app.example/api/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        origin: "https://app.example",
        "if-match": '"1"',
      },
      ...(method === "PATCH"
        ? {
            body: JSON.stringify({
              name: "Production",
              engine: "postgres",
              provider: "generic",
              host: "db.example.com",
              port: 5432,
              database: "app",
              sslmode: "verify-full",
              readonlyDefault: true,
              allowWrites: false,
            }),
          }
        : {}),
    },
  );
}

function authorizationRequest(action: "read" | "write") {
  return new Request(
    `https://app.example/api/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example",
      },
      body: JSON.stringify({ action }),
    },
  );
}

const connection = {
  id: connectionId,
  name: "Production",
  engine: "postgres",
  provider: "generic",
  driverId: null,
  host: "db.example.com",
  port: 5432,
  databaseName: "app",
  sslmode: "verify-full",
  readonlyDefault: true,
  allowWrites: false,
  environment: null,
  schemaGroup: null,
  credentialMode: "member_local",
  providerIntegrationId: null,
  revision: 1,
  contentRevision: 1,
  updatedAt: new Date("2026-07-23T00:00:00Z"),
  revocationPendingAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  authorizationRows.splice(0, authorizationRows.length, {
    id: connectionId,
    revision: connection.revision,
    contentRevision: connection.contentRevision,
    readonlyDefault: connection.readonlyDefault,
    allowWrites: connection.allowWrites,
    credentialMode: connection.credentialMode,
    provider: connection.provider,
    providerIntegrationId: connection.providerIntegrationId,
    revocationPendingAt: connection.revocationPendingAt,
    integrationStatus: null,
    integrationProvider: null,
    integrationRevokedAt: null,
    integrationRevocationPendingAt: null,
    integrationRevocationClaimId: null,
  });
  authorizeWorkspaceConnectionMock.mockResolvedValue({
    ok: true,
    role: "admin",
    accessMode: "manage",
    session: { session: { id: "session-id" }, user: { id: "admin-user" } },
    membership: { id: "member-id" },
  });
  connectionFindMock.mockResolvedValue(connection);
  versionFindMock.mockResolvedValue({
    id: "55555555-5555-4555-8555-555555555555",
    revision: 1,
  });
  claimMock.mockResolvedValue(claim);
  clearMock.mockResolvedValue(true);
  releaseMock.mockResolvedValue(true);
  revokeMock.mockResolvedValue({ revoked: 0, deferred: 0 });
  conflictMock.mockResolvedValue("44444444-4444-4444-8444-444444444444");
  commitMock.mockResolvedValue({ ...connection, contentRevision: 2, revision: 2 });
  batchMock.mockResolvedValue([
    [{ ...connection, revision: 3, updatedAt: new Date() }],
    {},
  ]);
});

describe("connection authority mutation gate", () => {
  it("requires an explicit If-Match before reading or mutating a connection", async () => {
    const missingRevision = new Request(
      `https://app.example/api/v1/workspaces/${workspaceId}/connections/${connectionId}`,
      { method: "PATCH", headers: { origin: "https://app.example" }, body: "{}" },
    );

    const response = await PATCH(missingRevision, context);

    expect(response.status).toBe(428);
    expect(connectionFindMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("fails closed while a connection authority mutation is pending", async () => {
    authorizationRows[0] = {
      ...authorizationRows[0] as object,
      revocationPendingAt: new Date(),
    };

    const response = await POST(authorizationRequest("read"), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Connection access is changing. Retry shortly.",
    });
  });

  it("rejects a write action before authority or target lookup", async () => {
    const response = await POST(authorizationRequest("write"), context);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Shared connections are read-only",
    });
    expect(authorizeWorkspaceConnectionMock).not.toHaveBeenCalled();
  });

  it("requires a fresh per-connection use grant for a known connection UUID", async () => {
    authorizeWorkspaceConnectionMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Connection grant denied",
    });

    const response = await POST(authorizationRequest("read"), context);

    expect(response.status).toBe(403);
    expect(authorizeWorkspaceConnectionMock).toHaveBeenCalledWith(
      expect.any(Request), workspaceId, connectionId, "use",
    );
    expect(connectionFindMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "pending",
      integrationStatus: "active",
      integrationProvider: "neon",
      integrationRevokedAt: null,
      integrationRevocationPendingAt: new Date(),
      integrationRevocationClaimId: "44444444-4444-4444-8444-444444444444",
    },
    {
      label: "revoked",
      integrationStatus: "revoked",
      integrationProvider: "neon",
      integrationRevokedAt: new Date(),
      integrationRevocationPendingAt: null,
      integrationRevocationClaimId: null,
    },
    {
      label: "inactive",
      integrationStatus: "inactive",
      integrationProvider: "neon",
      integrationRevokedAt: null,
      integrationRevocationPendingAt: null,
      integrationRevocationClaimId: null,
    },
    {
      label: "provider mismatch",
      integrationStatus: "active",
      integrationProvider: "gcpCloudSql",
      integrationRevokedAt: null,
      integrationRevocationPendingAt: null,
      integrationRevocationClaimId: null,
    },
  ])("fails a managed connection closed for a $label integration", async (state) => {
    authorizationRows[0] = {
      ...authorizationRows[0] as object,
      credentialMode: "managed",
      provider: "neon",
      providerIntegrationId: "33333333-3333-4333-8333-333333333333",
      ...state,
    };

    const response = await POST(authorizationRequest("read"), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Shared connection template is unsafe",
    });
  });

  it("authorizes an active managed template without returning credential material", async () => {
    authorizationRows[0] = {
      ...authorizationRows[0] as object,
      credentialMode: "managed",
      provider: "neon",
      providerIntegrationId: "33333333-3333-4333-8333-333333333333",
      integrationStatus: "active",
      integrationProvider: "neon",
      integrationRevokedAt: null,
      integrationRevocationPendingAt: null,
      integrationRevocationClaimId: null,
    };

    const response = await POST(authorizationRequest("read"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      allowed: true,
      action: "read",
      role: "admin",
      accessMode: "manage",
      revision: 1,
    });
  });

  it("rejects a concurrent PATCH claimant before lease revocation", async () => {
    claimMock.mockResolvedValue(null);

    const response = await PATCH(request("PATCH"), context);

    expect(response.status).toBe(409);
    expect(revokeMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("preserves a stale offline update as an opaque conflict without revoking access", async () => {
    const staleRequest = new Request(
      `https://app.example/api/v1/workspaces/${workspaceId}/connections/${connectionId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example",
          "if-match": '"0"',
        },
        body: JSON.stringify({
          name: "Offline copy", engine: "postgres", provider: "generic",
          host: "db.example.com", port: 5432, database: "app", sslmode: "verify-full",
          readonlyDefault: true, allowWrites: false,
        }),
      },
    );

    const response = await PATCH(staleRequest, context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Connection conflict",
      conflictId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("publishes no conflict when in-command authority revalidation is lost", async () => {
    conflictMock.mockRejectedValue(new Error("authority lost"));
    const staleRequest = new Request(
      `https://app.example/api/v1/workspaces/${workspaceId}/connections/${connectionId}`,
      { method: "PATCH", headers: { "content-type": "application/json", origin: "https://app.example", "if-match": '"0"' }, body: JSON.stringify({
        name: "Offline copy", engine: "postgres", provider: "generic", host: "db.example.com", port: 5432,
        database: "app", sslmode: "verify-full", readonlyDefault: true, allowWrites: false,
      }) },
    );

    const response = await PATCH(staleRequest, context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Connection changed concurrently. Retry the update." });
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("rejects a claim that does not follow the parsed template revision", async () => {
    claimMock.mockResolvedValue({ ...claim, connectionRevision: 4 });

    const response = await PATCH(request("PATCH"), context);

    expect(response.status).toBe(409);
    expect(clearMock).toHaveBeenCalledWith(expect.objectContaining({
      connectionRevision: 4,
    }));
    expect(releaseMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("releases only a stale takeover claim on a revision mismatch", async () => {
    claimMock.mockResolvedValue({
      ...claim,
      firstPending: false,
      connectionRevision: 4,
    });

    const response = await PATCH(request("PATCH"), context);

    expect(response.status).toBe(409);
    expect(releaseMock).toHaveBeenCalledWith(expect.objectContaining({
      firstPending: false,
      connectionRevision: 4,
    }));
    expect(clearMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("rejects a DELETE claim whose authority revision no longer matches", async () => {
    claimMock.mockResolvedValue({ ...claim, connectionRevision: 4 });

    const response = await DELETE(request("DELETE"), context);

    expect(response.status).toBe(409);
    expect(clearMock).toHaveBeenCalledWith(expect.objectContaining({ connectionRevision: 4 }));
    expect(commitMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("normalizes a managed provider before committing projection and version payload", async () => {
    connectionFindMock.mockResolvedValue({
      ...connection, credentialMode: "managed", provider: "neon", engine: "postgres",
    });

    const response = await PATCH(request("PATCH"), context);

    expect(response.status).toBe(200);
    expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        provider: "neon",
        payload: expect.objectContaining({ provider: "neon" }),
      }),
    }));
  });

  it("publishes no mutation result when final claim or authority revalidation loses", async () => {
    commitMock.mockResolvedValue(null);

    const response = await PATCH(request("PATCH"), context);

    expect(response.status).toBe(409);
    expect(clearMock).toHaveBeenCalledWith(claim);
  });

  it("increments only the content revision when the template mutation commits", async () => {
    const response = await PATCH(request("PATCH"), context);

    expect(response.status).toBe(200);
    expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({
      expectedContentRevision: 1,
      expectedAuthorityRevision: 2,
      mutation: expect.objectContaining({ kind: "update" }),
    }));
  });

  it("clears a first-pending DELETE claim when revocation defers", async () => {
    revokeMock.mockResolvedValue({ revoked: 0, deferred: 1 });

    const response = await DELETE(request("DELETE"), context);

    expect(response.status).toBe(409);
    expect(revokeMock).toHaveBeenCalledWith({
      organizationId: workspaceId,
      connectionId,
    });
    expect(clearMock).toHaveBeenCalledWith(claim);
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("retries content history after a first-pending deferred revocation", async () => {
    revokeMock.mockResolvedValueOnce({ revoked: 0, deferred: 1 });

    expect((await PATCH(request("PATCH"), context)).status).toBe(409);
    revokeMock.mockResolvedValueOnce({ revoked: 1, deferred: 0 });

    expect((await PATCH(request("PATCH"), context)).status).toBe(200);
    expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({
      expectedContentRevision: 1,
      expectedAuthorityRevision: 2,
    }));
  });

  it("clears a first-pending claim when revocation throws and never mutates authority", async () => {
    revokeMock.mockRejectedValue(new Error("provider unavailable"));

    await expect(PATCH(request("PATCH"), context)).rejects.toThrow(
      "provider unavailable",
    );
    expect(clearMock).toHaveBeenCalledWith(claim);
    expect(batchMock).not.toHaveBeenCalled();
  });
});
