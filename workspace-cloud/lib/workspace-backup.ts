// Server-only workspace snapshot encryption. Plaintext exists only between a DB read
// and envelope operation or restore validation, and is never returned from a route.
import "server-only";

import { hkdfSync } from "node:crypto";

import { decodeEnvelopeKey } from "./secret-envelope-core";
import { env } from "./env";
import {
  openWorkspaceSnapshot,
  sealWorkspaceSnapshot,
  snapshotHash,
  WORKSPACE_BACKUP_KEY_REFERENCE,
  WORKSPACE_BACKUP_KEY_VERSION,
  type WorkspaceMetadataSnapshot,
} from "./workspace-backup-core";

const BACKUP_KDF_SALT = Buffer.from("dopedb:workspace-backup:hkdf-sha256:v1:salt", "utf8");
const BACKUP_KDF_LABEL = "dopedb:workspace-backup:hkdf-sha256:v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The provider envelope and backup envelope deliberately never use the same AES key.
// Buffer.from(ArrayBuffer) shares hkdfSync's result without serializing or persisting it.
export function deriveWorkspaceBackupKey(masterKey: Buffer, workspaceId: string): Buffer {
  if (!UUID.test(workspaceId)) throw new Error("Invalid workspace id for backup key derivation");
  const result = hkdfSync(
    "sha256",
    masterKey,
    BACKUP_KDF_SALT,
    Buffer.from(`${BACKUP_KDF_LABEL}:workspace:${workspaceId.toLowerCase()}`, "utf8"),
    32,
  );
  return Buffer.from(result);
}

function withWorkspaceBackupKey<T>(workspaceId: string, operation: (key: Buffer) => T): T {
  const masterKey = decodeEnvelopeKey(env.credentialKey());
  let derivedKey: Buffer | undefined;
  try {
    derivedKey = deriveWorkspaceBackupKey(masterKey, workspaceId);
    return operation(derivedKey);
  } finally {
    // These buffers are request-local key material. Do not retain either the
    // deployment master-key copy or the workspace-domain key after the envelope call.
    derivedKey?.fill(0);
    masterKey.fill(0);
  }
}

export {
  snapshotHash,
  WORKSPACE_BACKUP_KEY_REFERENCE,
  WORKSPACE_BACKUP_KEY_VERSION,
  type WorkspaceMetadataSnapshot,
};

export function sealWorkspaceMetadataBackup(
  workspaceId: string,
  backupId: string,
  snapshot: WorkspaceMetadataSnapshot,
) {
  return withWorkspaceBackupKey(workspaceId, (key) =>
    sealWorkspaceSnapshot(key, workspaceId, backupId, snapshot));
}

export function openWorkspaceMetadataBackup(
  workspaceId: string,
  backupId: string,
  ciphertext: string,
) {
  return withWorkspaceBackupKey(workspaceId, (key) =>
    openWorkspaceSnapshot(key, workspaceId, backupId, ciphertext));
}
