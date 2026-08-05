// Owner-approved, resumable workspace DEK rotation. Each request owns a short
// database claim, advances a bounded batch, and can be safely retried after a
// lost response because already re-encrypted backups no longer match the job.
import "server-only";

import { and, asc, count, desc, eq, isNull, max, ne, or, sql } from "drizzle-orm";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { db } from "./db";
import {
  openWorkspaceMetadataBackupWithKms,
  sealWorkspaceMetadataBackupWithDataKey,
  snapshotHash,
  WORKSPACE_DATA_KEY_REFERENCE,
  workspaceDataKeyVersion,
} from "./workspace-backup";
import {
  ensureActiveWorkspaceDataKey,
  withWorkspaceDataKey,
  workspaceDataKeyById,
  type WorkspaceKmsSession,
} from "./workspace-data-key";
import {
  workspaceDataKey,
  workspaceDataKeyRotation,
  workspaceMetadataBackup,
} from "./schema";
import { wrapWorkspaceDataKey } from "./workspace-kms";
import { WorkspaceKmsError } from "./workspace-kms-core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_SECONDS = 70;
export const WORKSPACE_DATA_KEY_ROTATION_BATCH = 8;

export type WorkspaceDataKeyRotationAuthority = {
  sessionId: string;
  userId: string;
  membershipId: string;
};

type ClaimedRotation = {
  rotationId: string;
  claimId: string;
};

function sameHash(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function runningRotation(organizationId: string) {
  return db.query.workspaceDataKeyRotation.findFirst({
    where: and(
      eq(workspaceDataKeyRotation.organizationId, organizationId),
      eq(workspaceDataKeyRotation.status, "running"),
    ),
    orderBy: [desc(workspaceDataKeyRotation.createdAt)],
  });
}

async function claimRunningRotation(input: {
  organizationId: string;
  authority: WorkspaceDataKeyRotationAuthority;
}): Promise<ClaimedRotation | null> {
  const claimId = crypto.randomUUID();
  const result = await db.execute<{ rotationId: string }>(sql`
    WITH authority AS (
      SELECT member."id"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = 'owner'
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), claimed AS (
      UPDATE "workspace_control"."workspace_data_key_rotation" rotation
      SET "claim_id" = ${claimId}::uuid,
          "claim_expires_at" = now() + (${CLAIM_SECONDS} * interval '1 second'),
          "updated_at" = now()
      FROM authority
      WHERE rotation."organization_id" = ${input.organizationId}
        AND rotation."status" = 'running'
        AND (rotation."claim_id" IS NULL OR rotation."claim_expires_at" <= now())
      RETURNING rotation."id"::text AS "rotationId"
    ) SELECT "rotationId" FROM claimed
  `);
  const rotationId = result.rows[0]?.rotationId;
  return typeof rotationId === "string" && UUID.test(rotationId)
    ? { rotationId, claimId }
    : null;
}

async function startRotation(input: {
  organizationId: string;
  authority: WorkspaceDataKeyRotationAuthority;
  kms: WorkspaceKmsSession;
  idempotencyKey: string;
}): Promise<ClaimedRotation | null> {
  const active = await ensureActiveWorkspaceDataKey({
    organizationId: input.organizationId,
    actorUserId: input.authority.userId,
    kms: input.kms,
  });
  const [maximum] = await db.select({ value: max(workspaceDataKey.version) })
    .from(workspaceDataKey)
    .where(eq(workspaceDataKey.organizationId, input.organizationId));
  const version = Number(maximum.value ?? active.version) + 1;
  if (!Number.isSafeInteger(version) || version < 2 || version > 2_147_483_647) {
    throw new WorkspaceKmsError("integrity", 409);
  }
  const dataKeyId = crypto.randomUUID();
  const rotationId = crypto.randomUUID();
  const claimId = crypto.randomUUID();
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
    const result = await db.execute<{ rotationId: string }>(sql`
      WITH key_lock AS (
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`workspace-data-key:${input.organizationId}`}, 0
        ))
      ), authority AS (
        SELECT member."id"
        FROM "workspace_control"."session" session
        JOIN "workspace_control"."member" member
          ON member."id" = ${input.authority.membershipId}
         AND member."organization_id" = ${input.organizationId}
         AND member."user_id" = ${input.authority.userId}
        JOIN key_lock ON TRUE
        WHERE session."id" = ${input.authority.sessionId}
          AND session."user_id" = ${input.authority.userId}
          AND session."expires_at" > now()
          AND member."role" = 'owner'
          AND member."revocation_pending_at" IS NULL
          AND member."revocation_claim_id" IS NULL
        FOR UPDATE OF session, member
      ), current_key AS MATERIALIZED (
        SELECT key."id", key."version"
        FROM "workspace_control"."workspace_data_key" key
        JOIN authority ON TRUE
        WHERE key."id" = ${active.id}::uuid
          AND key."organization_id" = ${input.organizationId}
          AND key."version" = ${active.version}
          AND key."retired_at" IS NULL
          AND key."destroyed_at" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "workspace_control"."workspace_data_key_rotation" rotation
            WHERE rotation."organization_id" = ${input.organizationId}
              AND rotation."status" = 'running'
          )
        FOR UPDATE OF key
      ), retired AS (
        UPDATE "workspace_control"."workspace_data_key" key
        SET "retired_at" = now()
        FROM current_key
        WHERE key."id" = current_key."id"
          AND ${version} = (
            SELECT max(candidate."version") + 1
            FROM "workspace_control"."workspace_data_key" candidate
            WHERE candidate."organization_id" = ${input.organizationId}
          )
        RETURNING key."id"
      ), inserted_key AS (
        INSERT INTO "workspace_control"."workspace_data_key"
          ("id", "organization_id", "version", "key_reference", "kms_key_version",
           "wrapped_key", "created_by_user_id")
        SELECT ${dataKeyId}::uuid, ${input.organizationId}, ${version},
          ${input.kms.configuration.keyName}, ${wrapped.kmsKeyVersion},
          ${wrapped.wrappedKey}, ${input.authority.userId}
        FROM retired
        RETURNING "id"
      ), inserted_rotation AS (
        INSERT INTO "workspace_control"."workspace_data_key_rotation"
          ("id", "organization_id", "from_data_key_id", "to_data_key_id",
           "idempotency_key", "status", "claim_id", "claim_expires_at",
           "created_by_user_id")
        SELECT ${rotationId}::uuid, ${input.organizationId}, ${active.id}::uuid,
          inserted_key."id", ${input.idempotencyKey}::uuid, 'running', ${claimId}::uuid,
          now() + (${CLAIM_SECONDS} * interval '1 second'), ${input.authority.userId}
        FROM inserted_key
        RETURNING "id"
      ), profile_updated AS (
        UPDATE "workspace_control"."workspace_profile" profile
        SET "encryption_key_ref" = 'workspace-data-key:' || inserted_key."id"::text,
            "updated_at" = now()
        FROM inserted_key
        WHERE profile."organization_id" = ${input.organizationId}
        RETURNING profile."organization_id"
      ), audit AS (
        INSERT INTO "workspace_control"."workspace_audit_event"
          ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
           "redacted_summary", "request_id")
        SELECT ${input.organizationId}, ${input.authority.userId},
          'workspace.data_key.rotation.start', 'workspace_data_key_rotation',
          inserted_rotation."id"::text,
          jsonb_build_object(
            'fromVersion', ${active.version}::integer,
            'toVersion', ${version}::integer
          ),
          gen_random_uuid()
        FROM inserted_rotation
        RETURNING "id"
      )
      SELECT inserted_rotation."id"::text AS "rotationId"
      FROM inserted_rotation JOIN audit ON TRUE
    `);
    return result.rows[0]?.rotationId === rotationId ? { rotationId, claimId } : null;
  } finally {
    plaintextKey.fill(0);
  }
}

export async function beginOrClaimWorkspaceDataKeyRotation(input: {
  organizationId: string;
  authority: WorkspaceDataKeyRotationAuthority;
  kms: WorkspaceKmsSession;
  idempotencyKey: string;
}) {
  if (!UUID.test(input.organizationId) || !UUID.test(input.idempotencyKey)) {
    throw new WorkspaceKmsError("integrity", 409);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const replay = await db.query.workspaceDataKeyRotation.findFirst({
      where: and(
        eq(workspaceDataKeyRotation.organizationId, input.organizationId),
        eq(workspaceDataKeyRotation.idempotencyKey, input.idempotencyKey),
      ),
    });
    if (replay?.status === "completed") {
      return { claim: null, busy: false, replayed: true };
    }
    if (await runningRotation(input.organizationId)) {
      return {
        claim: await claimRunningRotation(input),
        busy: true,
        replayed: false,
      };
    }
    const started = await startRotation(input);
    if (started) return { claim: started, busy: false, replayed: false };
  }
  return { claim: await claimRunningRotation(input), busy: true, replayed: false };
}

async function releaseRotationClaim(input: {
  organizationId: string;
  rotationId: string;
  claimId: string;
}) {
  await db.update(workspaceDataKeyRotation).set({
    claimId: null,
    claimExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(workspaceDataKeyRotation.id, input.rotationId),
    eq(workspaceDataKeyRotation.organizationId, input.organizationId),
    eq(workspaceDataKeyRotation.claimId, input.claimId),
    eq(workspaceDataKeyRotation.status, "running"),
  ));
}

async function finishRotationBatch(input: {
  organizationId: string;
  rotationId: string;
  claimId: string;
  processed: number;
  authority: WorkspaceDataKeyRotationAuthority;
}) {
  const result = await db.execute<{ status: string; processedBackups: number; remaining: number }>(sql`
    WITH claimed AS MATERIALIZED (
      SELECT rotation."id", rotation."from_data_key_id", rotation."to_data_key_id",
        rotation."processed_backups"
      FROM "workspace_control"."workspace_data_key_rotation" rotation
      JOIN "workspace_control"."session" session
        ON session."id" = ${input.authority.sessionId}
       AND session."user_id" = ${input.authority.userId}
       AND session."expires_at" > now()
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = rotation."organization_id"
       AND member."user_id" = ${input.authority.userId}
       AND member."role" = 'owner'
       AND member."revocation_pending_at" IS NULL
       AND member."revocation_claim_id" IS NULL
      WHERE rotation."id" = ${input.rotationId}::uuid
        AND rotation."organization_id" = ${input.organizationId}
        AND rotation."status" = 'running'
        AND rotation."claim_id" = ${input.claimId}::uuid
        AND rotation."claim_expires_at" > now()
      FOR UPDATE OF rotation
    ), remaining AS MATERIALIZED (
      SELECT count(*)::integer AS value
      FROM "workspace_control"."workspace_metadata_backup" backup
      JOIN claimed ON TRUE
      WHERE backup."organization_id" = ${input.organizationId}
        AND backup."data_key_id" IS DISTINCT FROM claimed."to_data_key_id"
    ), advanced AS (
      UPDATE "workspace_control"."workspace_data_key_rotation" rotation
      SET "processed_backups" = rotation."processed_backups" + ${input.processed},
          "status" = CASE WHEN remaining.value = 0 THEN 'completed' ELSE 'running' END,
          "claim_id" = NULL,
          "claim_expires_at" = NULL,
          "updated_at" = now(),
          "completed_at" = CASE WHEN remaining.value = 0 THEN now() ELSE NULL END
      FROM claimed, remaining
      WHERE rotation."id" = claimed."id"
      RETURNING rotation."id", rotation."from_data_key_id", rotation."to_data_key_id",
        rotation."status", rotation."processed_backups", remaining.value AS remaining
    ), destroyed AS (
      UPDATE "workspace_control"."workspace_data_key" key
      SET "wrapped_key" = NULL, "destroyed_at" = now()
      FROM advanced
      WHERE advanced."status" = 'completed'
        AND key."id" = advanced."from_data_key_id"
        AND key."organization_id" = ${input.organizationId}
        AND NOT EXISTS (
          SELECT 1 FROM "workspace_control"."workspace_metadata_backup" backup
          WHERE backup."organization_id" = ${input.organizationId}
            AND backup."data_key_id" = key."id"
        )
      RETURNING key."id"
    ), audit AS (
      INSERT INTO "workspace_control"."workspace_audit_event"
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        'workspace.data_key.rotation.complete', 'workspace_data_key_rotation',
        advanced."id"::text,
        jsonb_build_object('processedBackups', advanced."processed_backups"),
        gen_random_uuid()
      FROM advanced
      WHERE advanced."status" = 'completed'
      RETURNING "id"
    )
    SELECT "status" AS "status", "processed_backups" AS "processedBackups",
      remaining AS "remaining"
    FROM advanced
  `);
  const row = result.rows[0];
  if (!row) throw new WorkspaceKmsError("unavailable", 503);
  return {
    status: row.status === "completed" ? "completed" as const : "running" as const,
    processedBackups: Number(row.processedBackups),
    remaining: Number(row.remaining),
  };
}

export async function advanceWorkspaceDataKeyRotation(input: {
  organizationId: string;
  authority: WorkspaceDataKeyRotationAuthority;
  kms: WorkspaceKmsSession;
  claim: ClaimedRotation;
}) {
  const rotation = await db.query.workspaceDataKeyRotation.findFirst({
    where: and(
      eq(workspaceDataKeyRotation.id, input.claim.rotationId),
      eq(workspaceDataKeyRotation.organizationId, input.organizationId),
      eq(workspaceDataKeyRotation.status, "running"),
      eq(workspaceDataKeyRotation.claimId, input.claim.claimId),
    ),
  });
  if (!rotation || rotation.claimExpiresAt!.valueOf() <= Date.now()) {
    throw new WorkspaceKmsError("unavailable", 409);
  }
  const target = await workspaceDataKeyById(input.organizationId, rotation.toDataKeyId);
  if (!target || target.retiredAt || target.destroyedAt) {
    throw new WorkspaceKmsError("integrity", 409);
  }
  const backups = await db.select().from(workspaceMetadataBackup).where(and(
    eq(workspaceMetadataBackup.organizationId, input.organizationId),
    or(
      isNull(workspaceMetadataBackup.dataKeyId),
      ne(workspaceMetadataBackup.dataKeyId, target.id),
    ),
  )).orderBy(
    asc(workspaceMetadataBackup.createdAt),
    asc(workspaceMetadataBackup.id),
  ).limit(WORKSPACE_DATA_KEY_ROTATION_BATCH);

  let processed = 0;
  try {
    await withWorkspaceDataKey(input.kms, target, async (targetKey) => {
      for (const backup of backups) {
        const snapshot = await openWorkspaceMetadataBackupWithKms(input.kms, {
          workspaceId: input.organizationId,
          backupId: backup.id,
          ciphertext: backup.ciphertext,
          binding: {
            dataKeyId: backup.dataKeyId,
            keyReference: backup.keyReference,
            keyVersion: backup.keyVersion,
          },
        });
        if (
          snapshot.workspace.revision !== backup.sourceRevision
          || !sameHash(snapshotHash(snapshot), backup.snapshotHash)
        ) throw new WorkspaceKmsError("integrity", 409);
        const ciphertext = sealWorkspaceMetadataBackupWithDataKey(
          targetKey,
          target,
          backup.id,
          snapshot,
        );
        const updated = await db.execute<{ id: string }>(sql`
          UPDATE "workspace_control"."workspace_metadata_backup" backup
          SET "data_key_id" = ${target.id}::uuid,
              "key_reference" = ${WORKSPACE_DATA_KEY_REFERENCE},
              "key_version" = ${workspaceDataKeyVersion(target.version)},
              "ciphertext" = ${ciphertext},
              "reencrypted_at" = now(),
              "reencrypted_by_rotation_id" = ${rotation.id}::uuid
          WHERE backup."id" = ${backup.id}::uuid
            AND backup."organization_id" = ${input.organizationId}
            AND backup."data_key_id" IS NOT DISTINCT FROM ${backup.dataKeyId}::uuid
            AND backup."key_reference" = ${backup.keyReference}
            AND backup."key_version" = ${backup.keyVersion}
            AND backup."ciphertext" = ${backup.ciphertext}
            AND backup."snapshot_hash" = ${backup.snapshotHash}
            AND EXISTS (
              SELECT 1
              FROM "workspace_control"."workspace_data_key_rotation" claimed
              JOIN "workspace_control"."session" session
                ON session."id" = ${input.authority.sessionId}
               AND session."user_id" = ${input.authority.userId}
               AND session."expires_at" > now()
              JOIN "workspace_control"."member" member
                ON member."id" = ${input.authority.membershipId}
               AND member."organization_id" = claimed."organization_id"
               AND member."user_id" = ${input.authority.userId}
               AND member."role" = 'owner'
               AND member."revocation_pending_at" IS NULL
               AND member."revocation_claim_id" IS NULL
              WHERE claimed."id" = ${rotation.id}::uuid
                AND claimed."organization_id" = ${input.organizationId}
                AND claimed."status" = 'running'
                AND claimed."claim_id" = ${input.claim.claimId}::uuid
                AND claimed."claim_expires_at" > now()
            )
          RETURNING backup."id"::text AS "id"
        `);
        if (updated.rows[0]?.id === backup.id) processed += 1;
      }
    });
    return await finishRotationBatch({
      organizationId: input.organizationId,
      rotationId: input.claim.rotationId,
      claimId: input.claim.claimId,
      processed,
      authority: input.authority,
    });
  } catch (error) {
    await releaseRotationClaim({
      organizationId: input.organizationId,
      rotationId: input.claim.rotationId,
      claimId: input.claim.claimId,
    });
    throw error;
  }
}

export async function workspaceDataKeyRotationStatus(organizationId: string) {
  const [active, latest, backupCount] = await Promise.all([
    db.query.workspaceDataKey.findFirst({
      where: and(
        eq(workspaceDataKey.organizationId, organizationId),
        isNull(workspaceDataKey.retiredAt),
        isNull(workspaceDataKey.destroyedAt),
      ),
      orderBy: [desc(workspaceDataKey.version)],
    }),
    db.query.workspaceDataKeyRotation.findFirst({
      where: eq(workspaceDataKeyRotation.organizationId, organizationId),
      orderBy: [desc(workspaceDataKeyRotation.createdAt)],
    }),
    db.select({ value: count() }).from(workspaceMetadataBackup)
      .where(eq(workspaceMetadataBackup.organizationId, organizationId)),
  ]);
  const remaining = latest?.status === "running"
    ? await db.select({ value: count() }).from(workspaceMetadataBackup).where(and(
        eq(workspaceMetadataBackup.organizationId, organizationId),
        or(
          isNull(workspaceMetadataBackup.dataKeyId),
          ne(workspaceMetadataBackup.dataKeyId, latest.toDataKeyId),
        ),
      ))
    : [{ value: 0 }];
  const fromKey = latest?.fromDataKeyId
    ? await workspaceDataKeyById(organizationId, latest.fromDataKeyId)
    : null;
  const toKey = latest?.toDataKeyId
    ? await workspaceDataKeyById(organizationId, latest.toDataKeyId)
    : null;
  return {
    activeVersion: active?.version ?? null,
    backupCount: Number(backupCount[0]?.value ?? 0),
    rotation: latest && toKey ? {
      id: latest.id,
      status: latest.status === "completed" ? "completed" as const : "running" as const,
      fromVersion: fromKey?.version ?? null,
      toVersion: toKey.version,
      processedBackups: latest.processedBackups,
      remainingBackups: Number(remaining[0]?.value ?? 0),
      createdAt: latest.createdAt.toISOString(),
      completedAt: latest.completedAt?.toISOString() ?? null,
    } : null,
  };
}
