import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authorizeWorkspaceMock,
  executeMock,
  profileFindMock,
  sealBackupMock,
  snapshotHashMock,
  connectionsMock,
} = vi.hoisted(() => ({
  authorizeWorkspaceMock: vi.fn(),
  executeMock: vi.fn(),
  profileFindMock: vi.fn(),
  sealBackupMock: vi.fn(),
  snapshotHashMock: vi.fn(),
  connectionsMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../lib/db", () => ({
  db: {
    execute: executeMock,
    query: { workspaceProfile: { findFirst: profileFindMock } },
    select: () => ({ from: () => ({ where: connectionsMock }) }),
    insert: vi.fn(),
  },
}));
vi.mock("../../../../../../lib/env", () => ({ env: { appOrigin: () => "https://app.example" } }));
vi.mock("../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspace: authorizeWorkspaceMock,
}));
vi.mock("../../../../../../lib/workspace-backup", () => ({
  sealWorkspaceMetadataBackup: sealBackupMock,
  snapshotHash: snapshotHashMock,
  WORKSPACE_BACKUP_KEY_REFERENCE: "dopedb-workspace-backup-hkdf-sha256",
  WORKSPACE_BACKUP_KEY_VERSION: "v1",
}));
vi.mock("../../../../../../lib/workspace-connections", () => ({
  parseSharedConnection: (connection: unknown) => connection,
}));
vi.mock("../../../../../../lib/revocation-gates", () => ({
  revocationGateLockKey: () => "member:workspace:admin",
}));

import { POST } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ workspaceId }) };
const request = () => new Request(
  `https://app.example/api/v1/workspaces/${workspaceId}/backups`,
  { method: "POST", headers: { origin: "https://app.example" } },
);

function compiledExecute() {
  const statement = executeMock.mock.calls[0]?.[0] as SQL | undefined;
  if (!statement) throw new Error("Expected backup SQL");
  return new PgDialect().sqlToQuery(statement).sql.replace(/\s+/g, " ").trim();
}

const rawBackup = {
  id: "33333333-3333-4333-8333-333333333333",
  sourceRevision: "4",
  keyReference: "dopedb-workspace-backup-hkdf-sha256",
  keyVersion: "v1",
  snapshotHash: "a".repeat(64),
  createdAt: "2026-07-26T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  authorizeWorkspaceMock.mockResolvedValue({
    ok: true, role: "admin", accessMode: "manage",
    session: { session: { id: "session-id" }, user: { id: "admin-user" } },
    membership: { id: "member-id" },
  });
  profileFindMock.mockResolvedValue({
    organizationId: workspaceId, revision: 4, lifecycleState: "active", residencyRegion: "ap-northeast-2",
  });
  connectionsMock.mockResolvedValue([{
    id: connectionId, contentRevision: 8, name: "Analytics", engine: "postgres", provider: "neon",
    driverId: null, host: "db.example.com", port: 5432, database: "analytics", sslmode: "require",
    readonlyDefault: true, allowWrites: false, env: "prod", schemaGroup: null,
    credentialMode: "member_local", providerIntegrationId: null, providerResource: null,
  }]);
  sealBackupMock.mockReturnValue("ciphertext-never-returned");
  snapshotHashMock.mockReturnValue("a".repeat(64));
  executeMock.mockResolvedValue({ rows: [rawBackup] });
});

describe("workspace backup creation", () => {
  it("maps raw execute aliases and never returns ciphertext", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      backup: {
        id: rawBackup.id, sourceRevision: 4, keyReference: rawBackup.keyReference,
        keyVersion: rawBackup.keyVersion, snapshotHash: rawBackup.snapshotHash,
        createdAt: rawBackup.createdAt,
      },
    });
    const query = compiledExecute();
    expect(query).toContain('"source_revision" AS "sourceRevision"');
    expect(query).toContain('"created_at" AS "createdAt"');
    expect(query).not.toContain("RETURNING *");
  });

  it("never returns ciphertext, decrypted snapshot fields, or key material", async () => {
    const response = await POST(request(), context);
    const body = JSON.stringify(await response.json());

    expect(body).not.toContain("ciphertext-never-returned");
    expect(body).not.toContain("Analytics");
    expect(body).not.toContain("db.example.com");
    expect(body).not.toContain(Buffer.alloc(32, 7).toString("base64url"));
  });

  it("fails closed for a malformed raw driver row", async () => {
    executeMock.mockResolvedValue({ rows: [{ ...rawBackup, sourceRevision: "9007199254740992" }] });

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Workspace metadata changed concurrently. Retry backup." });
  });

  it.each([
    "actor authority loss",
    "profile revision/lifecycle/residency drift",
    "connection addition drift",
    "connection deletion drift",
    "connection field drift",
    "connection content revision drift",
  ])("publishes neither backup nor audit when final revalidation rejects %s", async () => {
    // All final CTE mismatches intentionally collapse to no returned inserted row.
    executeMock.mockResolvedValue({ rows: [] });

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    expect(sealBackupMock).toHaveBeenCalledOnce();
    const query = compiledExecute();
    expect(query).toContain("profile_snapshot");
    expect(query).toContain("supplied_connections");
    expect(query).toContain("current_connections");
    expect(query).toContain("snapshot_matches");
    expect(query).toContain("EXCEPT");
    expect(query).toContain('"credential_mode"');
    expect(query).toContain('"provider_integration_id"');
    expect(query).toContain('"provider_resource"');
    expect(query).toMatch(/workspace_metadata_backup[\s\S]*FROM snapshot_matches/);
    expect(query).toMatch(/workspace_audit_event[\s\S]*FROM inserted/);
  });
});
