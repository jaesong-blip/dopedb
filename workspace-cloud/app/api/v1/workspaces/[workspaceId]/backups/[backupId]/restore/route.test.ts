import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authorizeWorkspaceMock,
  backupFindMock,
  openBackupMock,
  restoreSnapshotMock,
  snapshotHashMock,
} = vi.hoisted(() => ({
  authorizeWorkspaceMock: vi.fn(),
  backupFindMock: vi.fn(),
  openBackupMock: vi.fn(),
  restoreSnapshotMock: vi.fn(),
  snapshotHashMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../../../lib/db", () => ({
  db: { query: { workspaceMetadataBackup: { findFirst: backupFindMock } } },
}));
vi.mock("../../../../../../../../lib/env", () => ({
  env: { appOrigin: () => "https://app.example" },
}));
vi.mock("../../../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspace: authorizeWorkspaceMock,
}));
vi.mock("../../../../../../../../lib/workspace-backup", () => ({
  openWorkspaceMetadataBackup: openBackupMock,
  snapshotHash: snapshotHashMock,
  WORKSPACE_BACKUP_KEY_REFERENCE: "dopedb-workspace-backup-hkdf-sha256",
  WORKSPACE_BACKUP_KEY_VERSION: "v1",
}));
vi.mock("../../../../../../../../lib/workspace-versioning-store", () => ({
  restoreWorkspaceSnapshot: restoreSnapshotMock,
}));

import { POST } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const backupId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const context = { params: Promise.resolve({ workspaceId, backupId }) };
const request = () => new Request(
  `https://app.example/api/v1/workspaces/${workspaceId}/backups/${backupId}/restore`,
  { method: "POST", headers: { origin: "https://app.example", "if-match": '"4"' } },
);

beforeEach(() => {
  vi.clearAllMocks();
  authorizeWorkspaceMock.mockResolvedValue({
    ok: true, role: "admin", accessMode: "manage",
    session: { session: { id: "session-id" }, user: { id: "admin-user" } },
    membership: { id: "member-id" },
  });
  backupFindMock.mockResolvedValue({
    id: backupId, ciphertext: "never-returned", deletedAt: null, sourceRevision: 2,
    keyReference: "dopedb-workspace-backup-hkdf-sha256", keyVersion: "v1", snapshotHash: "a".repeat(64),
  });
  snapshotHashMock.mockReturnValue("a".repeat(64));
  restoreSnapshotMock.mockResolvedValue({
    revision: 5, restored: 0, conflictIds: ["44444444-4444-4444-8444-444444444444"],
  });
  openBackupMock.mockReturnValue({
    version: 1,
    workspace: { organizationId: workspaceId, lifecycleState: "active", residencyRegion: null, revision: 2 },
    connections: [{
      id: connectionId, name: "Analytics", engine: "postgres", provider: "neon", driverId: null,
      contentRevision: 3,
      host: "db.example.com", port: 5432, database: "analytics", sslmode: "require",
      readonlyDefault: true, allowWrites: false, env: "prod", schemaGroup: null,
    }],
  });
});

describe("workspace backup restore", () => {
  it("preserves the current connection and returns only an opaque conflict id", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      restored: 0,
      conflictIds: ["44444444-4444-4444-8444-444444444444"],
    });
    expect(restoreSnapshotMock).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: workspaceId,
      expectedRevision: 4,
      sourceRevision: 2,
      authority: {
        sessionId: "session-id", userId: "admin-user", membershipId: "member-id", role: "admin",
      },
    }));
    expect(openBackupMock).toHaveBeenCalledWith(workspaceId, backupId, "never-returned");
  });

  it("fails a tampered envelope without exposing ciphertext or plaintext", async () => {
    openBackupMock.mockImplementation(() => { throw new Error("bad tag"); });

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Backup integrity validation failed" });
    expect(restoreSnapshotMock).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported key reference", { keyReference: "unknown" }],
    ["unsupported key version", { keyVersion: "v2" }],
    ["snapshot hash mismatch", { snapshotHash: "b".repeat(64) }],
    ["source revision mismatch", { sourceRevision: 3 }],
  ])("rejects %s before restore mutation", async (_label, patch) => {
    backupFindMock.mockResolvedValue({
      id: backupId, ciphertext: "never-returned", deletedAt: null, sourceRevision: 2,
      keyReference: "dopedb-workspace-backup-hkdf-sha256", keyVersion: "v1", snapshotHash: "a".repeat(64), ...patch,
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Backup integrity validation failed" });
    expect(restoreSnapshotMock).not.toHaveBeenCalled();
  });

  it("rejects a duplicate-id decrypted snapshot before issuing restore mutations", async () => {
    openBackupMock.mockImplementation(() => {
      // The envelope decrypts, then the strict snapshot parser rejects its duplicate id.
      throw new Error("Invalid workspace backup snapshot");
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Backup integrity validation failed" });
    expect(restoreSnapshotMock).not.toHaveBeenCalled();
  });

  it("does not mutate for a missing, foreign, or tombstoned backup", async () => {
    backupFindMock.mockResolvedValueOnce(null);
    expect((await POST(request(), context)).status).toBe(404);
    backupFindMock.mockResolvedValueOnce({
      id: backupId, ciphertext: "never-returned", deletedAt: new Date(), sourceRevision: 2,
    });
    expect((await POST(request(), context)).status).toBe(404);
    expect(restoreSnapshotMock).not.toHaveBeenCalled();
  });

  it("fails closed when another restore has claimed the workspace revision", async () => {
    restoreSnapshotMock.mockResolvedValue(null);

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    expect(restoreSnapshotMock).toHaveBeenCalledOnce();
  });

  it("publishes no restore result when the in-command authority or backup gate is lost", async () => {
    // Both races are intentionally collapsed to the same non-enumerating result.
    restoreSnapshotMock.mockResolvedValue(null);

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Workspace metadata changed concurrently. Retry restore.",
    });
    expect(restoreSnapshotMock).toHaveBeenCalledOnce();
  });

  it("denies a known backup id after member/session revocation before any lookup", async () => {
    authorizeWorkspaceMock.mockResolvedValue({
      ok: false, status: 403, error: "Workspace access denied",
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    expect(backupFindMock).not.toHaveBeenCalled();
    expect(restoreSnapshotMock).not.toHaveBeenCalled();
    expect(openBackupMock).not.toHaveBeenCalled();
  });
});
