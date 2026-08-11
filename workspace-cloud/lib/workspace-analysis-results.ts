// Workspace-data-key encryption for bounded internal Analysis Article result
// fragments. Plaintext is request-local and never stored or logged.
import "server-only";

import { openEnvelope, sealEnvelope } from "./secret-envelope-core";
import {
  createWorkspaceKmsSession,
  ensureActiveWorkspaceDataKey,
  withWorkspaceDataKey,
  workspaceDataKeyById,
  type WorkspaceKmsSession,
} from "./workspace-data-key";
import {
  WORKSPACE_DATA_KEY_REFERENCE,
  workspaceDataKeyVersion,
} from "./workspace-backup-core";
import {
  parseAnalysisResultFragment,
  type AnalysisResultFragmentPayload,
} from "./workspace-analysis-runs";
import { canonicalHash, canonicalJson } from "./workspace-versioning";

function aad(workspaceId: string, runId: string, blockId: string, ordinal: number) {
  return `dopedb:analysis-result:v1:${workspaceId}:${runId}:${blockId}:${ordinal}`;
}

export async function sealAnalysisResultFragments(input: {
  request: Request;
  workspaceId: string;
  actorUserId: string;
  runId: string;
  expiresAt: Date;
  fragments: readonly AnalysisResultFragmentPayload[];
}) {
  if (Number.isNaN(input.expiresAt.valueOf()) || input.expiresAt <= new Date()) {
    throw new Error("Invalid Analysis Article result retention");
  }
  const kms = await createWorkspaceKmsSession(input.request);
  const dataKey = await ensureActiveWorkspaceDataKey({
    organizationId: input.workspaceId,
    actorUserId: input.actorUserId,
    kms,
  });
  return withWorkspaceDataKey(kms, dataKey, (key) => input.fragments.map((fragment) => {
    const plaintext = canonicalJson(fragment);
    return {
      blockId: fragment.blockId,
      ordinal: fragment.ordinal,
      dataKeyId: dataKey.id,
      keyReference: WORKSPACE_DATA_KEY_REFERENCE,
      keyVersion: workspaceDataKeyVersion(dataKey.version),
      ciphertext: sealEnvelope(
        key,
        plaintext,
        aad(input.workspaceId, input.runId, fragment.blockId, fragment.ordinal),
      ),
      payloadHash: canonicalHash(fragment),
      rowCount: fragment.rows.length,
      plaintextBytes: Buffer.byteLength(plaintext, "utf8"),
      expiresAt: input.expiresAt,
    };
  }));
}

export async function openAnalysisResultFragmentWithKms(
  kms: WorkspaceKmsSession,
  input: {
    workspaceId: string;
    runId: string;
    blockId: string;
    ordinal: number;
    dataKeyId: string;
    keyReference: string;
    keyVersion: string;
    ciphertext: string;
    payloadHash: string;
  },
) {
  if (input.keyReference !== WORKSPACE_DATA_KEY_REFERENCE) {
    throw new Error("Invalid Analysis Article result key reference");
  }
  const dataKey = await workspaceDataKeyById(input.workspaceId, input.dataKeyId);
  if (!dataKey || workspaceDataKeyVersion(dataKey.version) !== input.keyVersion) {
    throw new Error("Analysis Article result key is unavailable");
  }
  const fragment = await withWorkspaceDataKey(kms, dataKey, (key) => {
    const plaintext = openEnvelope(
      key,
      input.ciphertext,
      aad(input.workspaceId, input.runId, input.blockId, input.ordinal),
    );
    return parseAnalysisResultFragment(JSON.parse(plaintext));
  });
  if (canonicalHash(fragment) !== input.payloadHash
    || fragment.blockId !== input.blockId || fragment.ordinal !== input.ordinal) {
    throw new Error("Analysis Article result integrity check failed");
  }
  return fragment;
}

export async function openAnalysisResultFragment(input: {
  request: Request;
  workspaceId: string;
  runId: string;
  blockId: string;
  ordinal: number;
  dataKeyId: string;
  keyReference: string;
  keyVersion: string;
  ciphertext: string;
  payloadHash: string;
}) {
  const kms = await createWorkspaceKmsSession(input.request);
  return openAnalysisResultFragmentWithKms(kms, input);
}

export type StoredAnalysisFragmentEnvelope = Readonly<{
  runId: string;
  blockId: string;
  ordinal: number;
  dataKeyId: string;
  keyReference: string;
  keyVersion: string;
  ciphertext: string;
  payloadHash: string;
}>;

export async function openAnalysisResultFragments(input: {
  request: Request;
  workspaceId: string;
  fragments: readonly StoredAnalysisFragmentEnvelope[];
}) {
  if (input.fragments.length === 0) return [];
  const kms = await createWorkspaceKmsSession(input.request);
  const byKey = new Map<string, StoredAnalysisFragmentEnvelope[]>();
  for (const fragment of input.fragments) {
    const rows = byKey.get(fragment.dataKeyId) ?? [];
    rows.push(fragment);
    byKey.set(fragment.dataKeyId, rows);
  }
  const opened: AnalysisResultFragmentPayload[] = [];
  for (const [dataKeyId, rows] of byKey) {
    const dataKey = await workspaceDataKeyById(input.workspaceId, dataKeyId);
    const first = rows[0]!;
    if (!dataKey || first.keyReference !== WORKSPACE_DATA_KEY_REFERENCE
      || workspaceDataKeyVersion(dataKey.version) !== first.keyVersion
      || rows.some((row) => row.keyReference !== first.keyReference
        || row.keyVersion !== first.keyVersion)) {
      throw new Error("Analysis Article result key is unavailable");
    }
    const values = await withWorkspaceDataKey(kms, dataKey, (key) => rows.map((row) => {
      const plaintext = openEnvelope(
        key,
        row.ciphertext,
        aad(input.workspaceId, row.runId, row.blockId, row.ordinal),
      );
      const fragment = parseAnalysisResultFragment(JSON.parse(plaintext));
      if (canonicalHash(fragment) !== row.payloadHash
        || fragment.blockId !== row.blockId || fragment.ordinal !== row.ordinal) {
        throw new Error("Analysis Article result integrity check failed");
      }
      return fragment;
    }));
    opened.push(...values);
  }
  return opened.sort((left, right) => left.blockId.localeCompare(right.blockId)
    || left.ordinal - right.ordinal);
}
