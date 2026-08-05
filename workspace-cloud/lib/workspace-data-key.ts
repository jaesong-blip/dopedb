// Durable per-workspace DEK versions. Plaintext key material is request-local,
// passed only to a callback, and zeroized before this module returns.
import "server-only";

import { and, desc, eq, isNull, max, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { db } from "./db";
import { workspaceDataKey } from "./schema";
import {
  unwrapWorkspaceDataKey,
  workspaceKmsAccessToken,
  workspaceKmsConfiguration,
  workspaceKmsOidcToken,
  wrapWorkspaceDataKey,
} from "./workspace-kms";
import { WorkspaceKmsError, type WorkspaceKmsConfiguration } from "./workspace-kms-core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CREATE_ATTEMPTS = 3;

export type WorkspaceDataKeyRow = typeof workspaceDataKey.$inferSelect;
export type WorkspaceKmsSession = {
  configuration: WorkspaceKmsConfiguration;
  accessToken: string;
};

type ReturnedDataKeyRow = {
  id: unknown;
  organizationId: unknown;
  version: unknown;
  keyReference: unknown;
  kmsKeyVersion: unknown;
  wrappedKey: unknown;
  createdByUserId: unknown;
  createdAt: unknown;
  retiredAt: unknown;
  destroyedAt: unknown;
};

function dateOrNull(value: unknown) {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

function returnedDataKey(row: ReturnedDataKeyRow): WorkspaceDataKeyRow | null {
  const version = typeof row.version === "number"
    ? row.version
    : typeof row.version === "string" ? Number(row.version) : NaN;
  const createdAt = dateOrNull(row.createdAt);
  const retiredAt = dateOrNull(row.retiredAt);
  const destroyedAt = dateOrNull(row.destroyedAt);
  if (
    typeof row.id !== "string"
    || !UUID.test(row.id)
    || typeof row.organizationId !== "string"
    || !UUID.test(row.organizationId)
    || !Number.isSafeInteger(version)
    || version < 1
    || typeof row.keyReference !== "string"
    || typeof row.kmsKeyVersion !== "string"
    || (row.wrappedKey !== null && typeof row.wrappedKey !== "string")
    || (row.createdByUserId !== null && typeof row.createdByUserId !== "string")
    || !createdAt
    || retiredAt === undefined
    || destroyedAt === undefined
  ) return null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    version,
    keyReference: row.keyReference,
    kmsKeyVersion: row.kmsKeyVersion,
    wrappedKey: row.wrappedKey as string | null,
    createdByUserId: row.createdByUserId as string | null,
    createdAt,
    retiredAt,
    destroyedAt,
  };
}

function assertUsableDataKey(
  row: WorkspaceDataKeyRow,
  configuration: WorkspaceKmsConfiguration,
) {
  if (
    row.keyReference !== configuration.keyName
    || !row.kmsKeyVersion.startsWith(`${configuration.keyName}/cryptoKeyVersions/`)
    || !row.wrappedKey
    || row.destroyedAt
  ) throw new WorkspaceKmsError("integrity", 409);
  return row;
}

export async function createWorkspaceKmsSession(request: Request): Promise<WorkspaceKmsSession> {
  const configuration = workspaceKmsConfiguration();
  const accessToken = await workspaceKmsAccessToken(
    configuration,
    workspaceKmsOidcToken(request),
  );
  return { configuration, accessToken };
}

export async function activeWorkspaceDataKey(organizationId: string) {
  if (!UUID.test(organizationId)) throw new WorkspaceKmsError("integrity", 409);
  return db.query.workspaceDataKey.findFirst({
    where: and(
      eq(workspaceDataKey.organizationId, organizationId),
      isNull(workspaceDataKey.retiredAt),
      isNull(workspaceDataKey.destroyedAt),
    ),
    orderBy: [desc(workspaceDataKey.version)],
  });
}

export async function ensureActiveWorkspaceDataKey(input: {
  organizationId: string;
  actorUserId: string;
  kms: WorkspaceKmsSession;
}) {
  if (!UUID.test(input.organizationId)) throw new WorkspaceKmsError("integrity", 409);
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const existing = await activeWorkspaceDataKey(input.organizationId);
    if (existing) return assertUsableDataKey(existing, input.kms.configuration);

    const [maximum] = await db.select({ value: max(workspaceDataKey.version) })
      .from(workspaceDataKey)
      .where(eq(workspaceDataKey.organizationId, input.organizationId));
    const version = Number(maximum.value ?? 0) + 1;
    if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) {
      throw new WorkspaceKmsError("integrity", 409);
    }
    const dataKeyId = crypto.randomUUID();
    const plaintextKey = randomBytes(32);
    try {
      const wrapped = await wrapWorkspaceDataKey({
        configuration: input.kms.configuration,
        accessToken: input.kms.accessToken,
        workspaceId: input.organizationId,
        dataKeyId,
        version,
        plaintextKey,
      });
      const result = await db.execute<ReturnedDataKeyRow>(sql`
        WITH key_lock AS (
          SELECT pg_advisory_xact_lock(hashtextextended(
            ${`workspace-data-key:${input.organizationId}`}, 0
          ))
        ), existing AS MATERIALIZED (
          SELECT key."id" AS "id", key."organization_id" AS "organizationId",
            key."version" AS "version", key."key_reference" AS "keyReference",
            key."kms_key_version" AS "kmsKeyVersion", key."wrapped_key" AS "wrappedKey",
            key."created_by_user_id" AS "createdByUserId", key."created_at" AS "createdAt",
            key."retired_at" AS "retiredAt", key."destroyed_at" AS "destroyedAt"
          FROM "workspace_control"."workspace_data_key" key
          JOIN key_lock ON TRUE
          WHERE key."organization_id" = ${input.organizationId}
            AND key."retired_at" IS NULL AND key."destroyed_at" IS NULL
          FOR UPDATE OF key
        ), inserted AS (
          INSERT INTO "workspace_control"."workspace_data_key"
            ("id", "organization_id", "version", "key_reference", "kms_key_version",
             "wrapped_key", "created_by_user_id")
          SELECT ${dataKeyId}::uuid, ${input.organizationId}, ${version},
            ${input.kms.configuration.keyName}, ${wrapped.kmsKeyVersion},
            ${wrapped.wrappedKey}, ${input.actorUserId}
          FROM key_lock
          WHERE NOT EXISTS (SELECT 1 FROM existing)
            AND ${version} = COALESCE((
              SELECT max(key."version") + 1
              FROM "workspace_control"."workspace_data_key" key
              WHERE key."organization_id" = ${input.organizationId}
            ), 1)
          ON CONFLICT DO NOTHING
          RETURNING "id" AS "id", "organization_id" AS "organizationId",
            "version" AS "version", "key_reference" AS "keyReference",
            "kms_key_version" AS "kmsKeyVersion", "wrapped_key" AS "wrappedKey",
            "created_by_user_id" AS "createdByUserId", "created_at" AS "createdAt",
            "retired_at" AS "retiredAt", "destroyed_at" AS "destroyedAt"
        ), profile_updated AS (
          UPDATE "workspace_control"."workspace_profile" profile
          SET "encryption_key_ref" = 'workspace-data-key:' || inserted."id"::text,
              "updated_at" = now()
          FROM inserted
          WHERE profile."organization_id" = ${input.organizationId}
          RETURNING profile."organization_id"
        )
        SELECT * FROM inserted
        UNION ALL
        SELECT * FROM existing
        LIMIT 1
      `);
      const row = result.rows[0] && returnedDataKey(result.rows[0]);
      if (row) return assertUsableDataKey(row, input.kms.configuration);
    } finally {
      plaintextKey.fill(0);
    }
  }
  throw new WorkspaceKmsError("unavailable", 503);
}

export async function workspaceDataKeyById(organizationId: string, dataKeyId: string) {
  if (!UUID.test(organizationId) || !UUID.test(dataKeyId)) {
    throw new WorkspaceKmsError("integrity", 409);
  }
  return db.query.workspaceDataKey.findFirst({
    where: and(
      eq(workspaceDataKey.organizationId, organizationId),
      eq(workspaceDataKey.id, dataKeyId),
    ),
  });
}

export async function unwrapStoredWorkspaceDataKey(
  kms: WorkspaceKmsSession,
  row: WorkspaceDataKeyRow,
) {
  const usable = assertUsableDataKey(row, kms.configuration);
  return unwrapWorkspaceDataKey({
    configuration: kms.configuration,
    accessToken: kms.accessToken,
    workspaceId: usable.organizationId,
    dataKeyId: usable.id,
    version: usable.version,
    wrappedKey: usable.wrappedKey!,
  });
}

export async function withWorkspaceDataKey<T>(
  kms: WorkspaceKmsSession,
  row: WorkspaceDataKeyRow,
  operation: (key: Buffer) => Promise<T> | T,
): Promise<T> {
  const plaintextKey = await unwrapStoredWorkspaceDataKey(kms, row);
  try {
    return await operation(plaintextKey);
  } finally {
    plaintextKey.fill(0);
  }
}
