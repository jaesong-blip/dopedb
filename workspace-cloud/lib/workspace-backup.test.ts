import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./env", () => ({
  env: { credentialKey: () => Buffer.alloc(32, 7).toString("base64url") },
}));

import { openEnvelope } from "./secret-envelope-core";
import { openProviderCredential, sealProviderCredential } from "./secret-envelope";
import {
  deriveWorkspaceBackupKey,
  openWorkspaceMetadataBackup,
  sealWorkspaceMetadataBackup,
} from "./workspace-backup";
import type { WorkspaceMetadataSnapshot } from "./workspace-backup-core";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const backupId = "22222222-2222-4222-8222-222222222222";
const snapshot: WorkspaceMetadataSnapshot = {
  version: 1,
  workspace: { organizationId: workspaceId, lifecycleState: "active", residencyRegion: null, revision: 4 },
  connections: [{
    id: "33333333-3333-4333-8333-333333333333", contentRevision: 4,
    name: "Analytics", engine: "postgres", provider: "neon", driverId: null,
    host: "db.example.com", port: 5432, database: "analytics", sslmode: "require",
    readonlyDefault: true, allowWrites: false, env: "prod", schemaGroup: null,
  }],
};

describe("workspace backup key domain", () => {
  it("round-trips only through the workspace-scoped backup key", () => {
    const encrypted = sealWorkspaceMetadataBackup(workspaceId, backupId, snapshot);

    expect(openWorkspaceMetadataBackup(workspaceId, backupId, encrypted)).toEqual(snapshot);
    expect(() => openWorkspaceMetadataBackup(randomWorkspaceId(), backupId, encrypted)).toThrow();
    expect(() => openWorkspaceMetadataBackup(workspaceId, randomWorkspaceId(), encrypted)).toThrow();
  });

  it("separates the raw provider-envelope master key from every backup key", () => {
    const master = Buffer.alloc(32, 7);
    const backupKey = deriveWorkspaceBackupKey(master, workspaceId);
    const encrypted = sealWorkspaceMetadataBackup(workspaceId, backupId, snapshot);
    const providerContext = "dopedb:provider-integration:provider-id";
    const providerCiphertext = sealProviderCredential("provider-id", { grant: "opaque" });

    expect(() => openEnvelope(master, encrypted, `dopedb:workspace-backup:${workspaceId}:${backupId}`)).toThrow();
    expect(() => openEnvelope(backupKey, providerCiphertext, providerContext)).toThrow();
    expect(openProviderCredential<{ grant: string }>("provider-id", providerCiphertext)).toEqual({ grant: "opaque" });
    expect(backupKey.equals(master)).toBe(false);
  });

  it("uses distinct HKDF output for each workspace without retaining derived material", () => {
    const master = randomBytes(32);
    expect(deriveWorkspaceBackupKey(master, workspaceId)).not.toEqual(
      deriveWorkspaceBackupKey(master, randomWorkspaceId()),
    );
  });

  it("zeroizes request-local master and derived backup buffers after envelope use", () => {
    const fill = vi.spyOn(Buffer.prototype, "fill");

    sealWorkspaceMetadataBackup(workspaceId, backupId, snapshot);

    expect(fill.mock.calls.filter(([value]) => value === 0)).toHaveLength(2);
  });

  it("zeroizes the decoded master buffer when key derivation rejects", () => {
    const fill = vi.spyOn(Buffer.prototype, "fill");

    expect(() => sealWorkspaceMetadataBackup("not-a-workspace-id", backupId, snapshot)).toThrow();

    expect(fill.mock.calls.filter(([value]) => value === 0)).toHaveLength(1);
  });
});

afterEach(() => vi.restoreAllMocks());

function randomWorkspaceId() {
  return crypto.randomUUID();
}
