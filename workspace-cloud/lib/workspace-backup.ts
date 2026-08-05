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
  WORKSPACE_DATA_KEY_REFERENCE,
  workspaceDataKeyVersion,
  type WorkspaceMetadataSnapshot,
} from "./workspace-backup-core";
import {
  createWorkspaceKmsSession,
  ensureActiveWorkspaceDataKey,
  withWorkspaceDataKey,
  workspaceDataKeyById,
  type WorkspaceDataKeyRow,
  type WorkspaceKmsSession,
} from "./workspace-data-key";
import { WorkspaceKmsError } from "./workspace-kms-core";

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
  WORKSPACE_DATA_KEY_REFERENCE,
  workspaceDataKeyVersion,
  type WorkspaceMetadataSnapshot,
};

export type WorkspaceBackupKeyBinding = {
  dataKeyId: string | null;
  keyReference: string;
  keyVersion: string;
};

export function sealWorkspaceMetadataBackupWithDataKey(
  key: Buffer,
  row: WorkspaceDataKeyRow,
  backupId: string,
  snapshot: WorkspaceMetadataSnapshot,
) {
  return sealWorkspaceSnapshot(key, row.organizationId, backupId, snapshot);
}

export async function sealWorkspaceMetadataBackup(input: {
  request: Request;
  workspaceId: string;
  actorUserId: string;
  backupId: string;
  snapshot: WorkspaceMetadataSnapshot;
}) {
  const kms = await createWorkspaceKmsSession(input.request);
  const dataKey = await ensureActiveWorkspaceDataKey({
    organizationId: input.workspaceId,
    actorUserId: input.actorUserId,
    kms,
  });
  const ciphertext = await withWorkspaceDataKey(kms, dataKey, (key) =>
    sealWorkspaceMetadataBackupWithDataKey(key, dataKey, input.backupId, input.snapshot));
  return {
    ciphertext,
    dataKeyId: dataKey.id,
    keyReference: WORKSPACE_DATA_KEY_REFERENCE,
    keyVersion: workspaceDataKeyVersion(dataKey.version),
  };
}

function legacyWorkspaceMetadataBackup(
  workspaceId: string,
  backupId: string,
  ciphertext: string,
) {
  return withWorkspaceBackupKey(workspaceId, (key) =>
    openWorkspaceSnapshot(key, workspaceId, backupId, ciphertext));
}

export async function openWorkspaceMetadataBackupWithKms(
  kms: WorkspaceKmsSession,
  input: {
    workspaceId: string;
    backupId: string;
    ciphertext: string;
    binding: WorkspaceBackupKeyBinding;
  },
) {
  const { binding } = input;
  if (
    binding.dataKeyId === null
    && binding.keyReference === WORKSPACE_BACKUP_KEY_REFERENCE
    && binding.keyVersion === WORKSPACE_BACKUP_KEY_VERSION
  ) {
    return legacyWorkspaceMetadataBackup(
      input.workspaceId,
      input.backupId,
      input.ciphertext,
    );
  }
  if (
    !binding.dataKeyId
    || binding.keyReference !== WORKSPACE_DATA_KEY_REFERENCE
    || !/^v[1-9][0-9]*$/.test(binding.keyVersion)
  ) throw new WorkspaceKmsError("integrity", 409);
  const dataKey = await workspaceDataKeyById(input.workspaceId, binding.dataKeyId);
  if (!dataKey || workspaceDataKeyVersion(dataKey.version) !== binding.keyVersion) {
    throw new WorkspaceKmsError("integrity", 409);
  }
  return withWorkspaceDataKey(kms, dataKey, (key) =>
    openWorkspaceSnapshot(key, input.workspaceId, input.backupId, input.ciphertext));
}

export async function openWorkspaceMetadataBackup(input: {
  request: Request;
  workspaceId: string;
  backupId: string;
  ciphertext: string;
  binding: WorkspaceBackupKeyBinding;
}) {
  if (
    input.binding.dataKeyId === null
    && input.binding.keyReference === WORKSPACE_BACKUP_KEY_REFERENCE
    && input.binding.keyVersion === WORKSPACE_BACKUP_KEY_VERSION
  ) {
    return legacyWorkspaceMetadataBackup(input.workspaceId, input.backupId, input.ciphertext);
  }
  const kms = await createWorkspaceKmsSession(input.request);
  return openWorkspaceMetadataBackupWithKms(kms, input);
}
