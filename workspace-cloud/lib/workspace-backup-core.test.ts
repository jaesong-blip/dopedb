import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  openWorkspaceSnapshot,
  parseWorkspaceMetadataSnapshot,
  sealWorkspaceSnapshot,
  snapshotHash,
} from "./workspace-backup-core";
import type { WorkspaceMetadataSnapshot } from "./workspace-backup-core";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const backupId = "22222222-2222-4222-8222-222222222222";
const snapshot: WorkspaceMetadataSnapshot = {
  version: 1 as const,
  workspace: { organizationId: workspaceId, lifecycleState: "active", residencyRegion: null, revision: 4 },
  connections: [{
    id: "33333333-3333-4333-8333-333333333333",
    contentRevision: 4,
    name: "Analytics", engine: "postgres", provider: "neon", driverId: null,
    host: "db.example.com", port: 5432, database: "analytics", sslmode: "require",
    readonlyDefault: true, allowWrites: false, env: "prod", schemaGroup: null,
  }],
};

describe("workspace metadata backup envelope", () => {
  it("binds ciphertext to both workspace and backup ids", () => {
    const key = randomBytes(32);
    const encrypted = sealWorkspaceSnapshot(key, workspaceId, backupId, snapshot);
    expect(openWorkspaceSnapshot(key, workspaceId, backupId, encrypted)).toEqual(snapshot);
    expect(() => openWorkspaceSnapshot(key, workspaceId, crypto.randomUUID(), encrypted)).toThrow();
    expect(() => openWorkspaceSnapshot(key, crypto.randomUUID(), backupId, encrypted)).toThrow();
  });

  it("rejects ciphertext tampering and secret-bearing restore entries", () => {
    const key = randomBytes(32);
    const encrypted = sealWorkspaceSnapshot(key, workspaceId, backupId, snapshot);
    expect(() => openWorkspaceSnapshot(key, workspaceId, backupId, `${encrypted}x`)).toThrow();
    expect(() => parseWorkspaceMetadataSnapshot({
      ...snapshot,
      connections: [{ ...snapshot.connections[0], token: "never-store" }],
    }, workspaceId)).toThrow(/Secret-bearing field/);
    expect(JSON.stringify(snapshot)).not.toMatch(/token|password|secret/i);
    expect(snapshotHash(snapshot)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects duplicate connection ids before a restore command can be formed", () => {
    expect(() => parseWorkspaceMetadataSnapshot({
      ...snapshot,
      connections: [snapshot.connections[0], { ...snapshot.connections[0] }],
    }, workspaceId)).toThrow(/Invalid workspace backup snapshot/);
  });

  it("keeps a legacy write preference in authenticated backup bytes for safe restore normalization", () => {
    const legacy = {
      ...snapshot,
      connections: [{
        ...snapshot.connections[0],
        readonlyDefault: false,
        allowWrites: true,
      }],
    };

    const parsed = parseWorkspaceMetadataSnapshot(legacy, workspaceId);
    expect(parsed.connections[0]).toMatchObject({
      readonlyDefault: false,
      allowWrites: true,
    });
    expect(snapshotHash(parsed)).toBe(snapshotHash(legacy));
  });
});
