// Owner-only workspace deletion lifecycle and system retention cleanup. Scheduling
// is reversible during the retention window; final purge is database-atomic and
// leaves only a payload-free deletion receipt.
import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "./db";
import { workspaceDeletionReceipt } from "./schema";

export const WORKSPACE_DELETION_RETENTION_DAYS = 7;
export const WORKSPACE_BACKUP_RETENTION_DAYS = 7;

export type WorkspaceLifecycleAuthority = {
  sessionId: string;
  userId: string;
  membershipId: string;
};

type LifecycleStatusRow = {
  workspaceName: unknown;
  revision: unknown;
  lifecycleState: unknown;
  deletionReceiptId: unknown;
  deletionRequestedAt: unknown;
  purgeAfter: unknown;
  activeProviderIntegrations: unknown;
  activeCredentialLeases: unknown;
  unresolvedProviderOperations: unknown;
  runningKeyRotations: unknown;
  memberRevocations: unknown;
  backupCount: unknown;
  tombstonedBackupCount: unknown;
};

function integer(value: unknown) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isoDate(value: unknown) {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

export async function workspaceLifecycleStatus(organizationId: string) {
  const result = await db.execute<LifecycleStatusRow>(sql`
    SELECT organization."name" AS "workspaceName",
      profile."revision" AS "revision",
      profile."lifecycle_state" AS "lifecycleState",
      profile."deletion_receipt_id"::text AS "deletionReceiptId",
      profile."deletion_requested_at" AS "deletionRequestedAt",
      profile."purge_after" AS "purgeAfter",
      (SELECT count(*)::integer
       FROM "workspace_control"."workspace_provider_integration" integration
       WHERE integration."organization_id" = profile."organization_id"
         AND (integration."revoked_at" IS NULL OR integration."status" <> 'revoked'))
        AS "activeProviderIntegrations",
      (SELECT count(*)::integer
       FROM "workspace_control"."workspace_credential_lease" lease
       WHERE lease."organization_id" = profile."organization_id"
         AND lease."revoked_at" IS NULL) AS "activeCredentialLeases",
      (SELECT count(*)::integer
       FROM "workspace_control"."workspace_provider_operation" operation
       WHERE operation."organization_id" = profile."organization_id"
         AND operation."state" NOT IN ('succeeded', 'failed', 'cancelled'))
        AS "unresolvedProviderOperations",
      (SELECT count(*)::integer
       FROM "workspace_control"."workspace_data_key_rotation" rotation
       WHERE rotation."organization_id" = profile."organization_id"
         AND rotation."status" = 'running') AS "runningKeyRotations",
      (SELECT count(*)::integer
       FROM "workspace_control"."member" pending_member
       WHERE pending_member."organization_id" = profile."organization_id"
         AND (pending_member."revocation_pending_at" IS NOT NULL
           OR pending_member."revocation_claim_id" IS NOT NULL)) AS "memberRevocations",
      (SELECT count(*)::integer
       FROM "workspace_control"."workspace_metadata_backup" backup
       WHERE backup."organization_id" = profile."organization_id"
         AND backup."deleted_at" IS NULL) AS "backupCount",
      (SELECT count(*)::integer
       FROM "workspace_control"."workspace_metadata_backup" backup
       WHERE backup."organization_id" = profile."organization_id"
         AND backup."deleted_at" IS NOT NULL) AS "tombstonedBackupCount"
    FROM "workspace_control"."workspace_profile" profile
    JOIN "workspace_control"."organization" organization
      ON organization."id" = profile."organization_id"
    WHERE profile."organization_id" = ${organizationId}
  `);
  const row = result.rows[0];
  if (!row || typeof row.workspaceName !== "string") return null;
  const blockers = {
    providerIntegrations: integer(row.activeProviderIntegrations),
    credentialLeases: integer(row.activeCredentialLeases),
    providerOperations: integer(row.unresolvedProviderOperations),
    keyRotations: integer(row.runningKeyRotations),
    memberRevocations: integer(row.memberRevocations),
  };
  return {
    workspaceName: row.workspaceName,
    revision: integer(row.revision),
    lifecycleState: row.lifecycleState === "deletion_pending"
      ? "deletion_pending" as const
      : "active" as const,
    deletionReceiptId: typeof row.deletionReceiptId === "string"
      ? row.deletionReceiptId
      : null,
    deletionRequestedAt: isoDate(row.deletionRequestedAt),
    purgeAfter: isoDate(row.purgeAfter),
    retentionDays: WORKSPACE_DELETION_RETENTION_DAYS,
    backupRetentionDays: WORKSPACE_BACKUP_RETENTION_DAYS,
    backupCount: integer(row.backupCount),
    tombstonedBackupCount: integer(row.tombstonedBackupCount),
    blockers,
    canScheduleDeletion: row.lifecycleState === "active"
      && Object.values(blockers).every((count) => count === 0),
  };
}

export async function scheduleWorkspaceDeletion(input: {
  organizationId: string;
  authority: WorkspaceLifecycleAuthority;
  requestId: string;
  confirmation: string;
}) {
  const existing = await db.query.workspaceDeletionReceipt.findFirst({
    where: and(
      eq(workspaceDeletionReceipt.id, input.requestId),
      eq(workspaceDeletionReceipt.organizationId, input.organizationId),
    ),
  });
  if (existing) return existing.status === "pending" ? "replayed" as const : null;

  const requestedAtDate = new Date();
  const requestedAt = requestedAtDate.toISOString();
  const purgeAfter = new Date(
    requestedAtDate.valueOf() + WORKSPACE_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const result = await db.execute<{ id: string }>(sql`
    WITH lifecycle_lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`workspace-lifecycle:${input.organizationId}`}, 0
      ))
    ), authority AS MATERIALIZED (
      SELECT profile."organization_id", profile."revision", organization."name"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN "workspace_control"."workspace_profile" profile
        ON profile."organization_id" = member."organization_id"
      JOIN "workspace_control"."organization" organization
        ON organization."id" = profile."organization_id"
      JOIN lifecycle_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = 'owner'
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
        AND profile."lifecycle_state" = 'active'
        AND organization."name" = ${input.confirmation}
        AND NOT EXISTS (
          SELECT 1 FROM "workspace_control"."member" pending_member
          WHERE pending_member."organization_id" = profile."organization_id"
            AND (pending_member."revocation_pending_at" IS NOT NULL
              OR pending_member."revocation_claim_id" IS NOT NULL)
        )
        AND NOT EXISTS (
          SELECT 1 FROM "workspace_control"."workspace_provider_integration" integration
          WHERE integration."organization_id" = profile."organization_id"
            AND (integration."revoked_at" IS NULL OR integration."status" <> 'revoked')
        )
        AND NOT EXISTS (
          SELECT 1 FROM "workspace_control"."workspace_credential_lease" lease
          WHERE lease."organization_id" = profile."organization_id"
            AND lease."revoked_at" IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM "workspace_control"."workspace_provider_operation" operation
          WHERE operation."organization_id" = profile."organization_id"
            AND operation."state" NOT IN ('succeeded', 'failed', 'cancelled')
        )
        AND NOT EXISTS (
          SELECT 1 FROM "workspace_control"."workspace_data_key_rotation" rotation
          WHERE rotation."organization_id" = profile."organization_id"
            AND rotation."status" = 'running'
        )
      FOR UPDATE OF session, member, profile, organization
    ), receipt AS (
      INSERT INTO "workspace_control"."workspace_deletion_receipt"
        ("id", "organization_id", "requested_by_user_id", "requested_at", "purge_after")
      SELECT ${input.requestId}::uuid, authority."organization_id",
        ${input.authority.userId}, ${requestedAt}::timestamptz, ${purgeAfter}::timestamptz
      FROM authority
      ON CONFLICT DO NOTHING
      RETURNING "id", "organization_id", "requested_at", "purge_after"
    ), profile_updated AS (
      UPDATE "workspace_control"."workspace_profile" profile
      SET "lifecycle_state" = 'deletion_pending',
          "deletion_receipt_id" = receipt."id",
          "deletion_requested_at" = receipt."requested_at",
          "purge_after" = receipt."purge_after",
          "revision" = profile."revision" + 1,
          "updated_at" = now()
      FROM receipt
      WHERE profile."organization_id" = receipt."organization_id"
        AND profile."lifecycle_state" = 'active'
      RETURNING profile."organization_id", profile."deletion_requested_at"
    ), members_suspended AS (
      UPDATE "workspace_control"."member" member
      SET "revocation_pending_at" = profile_updated."deletion_requested_at"
      FROM profile_updated
      WHERE member."organization_id" = profile_updated."organization_id"
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      RETURNING member."id"
    ), sessions_cleared AS (
      UPDATE "workspace_control"."session" session
      SET "active_organization_id" = NULL, "updated_at" = now()
      FROM profile_updated
      WHERE session."active_organization_id" = profile_updated."organization_id"
      RETURNING session."id"
    ), audit AS (
      INSERT INTO "workspace_control"."workspace_audit_event"
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT profile_updated."organization_id", ${input.authority.userId},
        'workspace.deletion.schedule', 'workspace', profile_updated."organization_id",
        jsonb_build_object('purgeAfter', receipt."purge_after"),
        ${input.requestId}::uuid
      FROM profile_updated JOIN receipt ON TRUE
      RETURNING "id"
    )
    SELECT receipt."id"::text AS "id"
    FROM receipt JOIN profile_updated ON TRUE JOIN audit ON TRUE
  `);
  return result.rows[0]?.id === input.requestId ? "scheduled" as const : null;
}

export async function cancelWorkspaceDeletion(input: {
  organizationId: string;
  authority: WorkspaceLifecycleAuthority;
  requestId: string;
}) {
  const existing = await db.query.workspaceDeletionReceipt.findFirst({
    where: and(
      eq(workspaceDeletionReceipt.id, input.requestId),
      eq(workspaceDeletionReceipt.organizationId, input.organizationId),
    ),
  });
  if (existing?.status === "cancelled") return "replayed" as const;
  if (existing?.status !== "pending") return null;
  const result = await db.execute<{ id: string }>(sql`
    WITH lifecycle_lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`workspace-lifecycle:${input.organizationId}`}, 0
      ))
    ), authority AS MATERIALIZED (
      SELECT profile."organization_id", profile."deletion_requested_at"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN "workspace_control"."workspace_profile" profile
        ON profile."organization_id" = member."organization_id"
      JOIN lifecycle_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = 'owner'
        AND member."revocation_claim_id" IS NULL
        AND member."revocation_pending_at" = profile."deletion_requested_at"
        AND profile."lifecycle_state" = 'deletion_pending'
        AND profile."deletion_receipt_id" = ${input.requestId}::uuid
        AND profile."purge_after" > now()
      FOR UPDATE OF session, member, profile
    ), receipt_cancelled AS (
      UPDATE "workspace_control"."workspace_deletion_receipt" receipt
      SET "status" = 'cancelled', "cancelled_at" = now()
      FROM authority
      WHERE receipt."id" = ${input.requestId}::uuid
        AND receipt."organization_id" = authority."organization_id"
        AND receipt."status" = 'pending'
        AND receipt."purge_after" > now()
      RETURNING receipt."id", receipt."organization_id"
    ), profile_updated AS (
      UPDATE "workspace_control"."workspace_profile" profile
      SET "lifecycle_state" = 'active',
          "deletion_receipt_id" = NULL,
          "deletion_requested_at" = NULL,
          "purge_after" = NULL,
          "revision" = profile."revision" + 1,
          "updated_at" = now()
      FROM authority, receipt_cancelled
      WHERE profile."organization_id" = receipt_cancelled."organization_id"
      RETURNING profile."organization_id", authority."deletion_requested_at"
    ), members_resumed AS (
      UPDATE "workspace_control"."member" member
      SET "revocation_pending_at" = NULL
      FROM profile_updated
      WHERE member."organization_id" = profile_updated."organization_id"
        AND member."revocation_pending_at" = profile_updated."deletion_requested_at"
        AND member."revocation_claim_id" IS NULL
      RETURNING member."id"
    ), session_restored AS (
      UPDATE "workspace_control"."session" session
      SET "active_organization_id" = profile_updated."organization_id",
          "updated_at" = now()
      FROM profile_updated
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
      RETURNING session."id"
    ), audit AS (
      INSERT INTO "workspace_control"."workspace_audit_event"
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT profile_updated."organization_id", ${input.authority.userId},
        'workspace.deletion.cancel', 'workspace', profile_updated."organization_id",
        '{}'::jsonb, gen_random_uuid()
      FROM profile_updated
      RETURNING "id"
    )
    SELECT receipt_cancelled."id"::text AS "id"
    FROM receipt_cancelled JOIN profile_updated ON TRUE JOIN audit ON TRUE
  `);
  return result.rows[0]?.id === input.requestId ? "cancelled" as const : null;
}

export async function cleanupWorkspaceRetention(input: {
  backupLimit?: number;
  workspaceLimit?: number;
} = {}) {
  const backupLimit = Math.max(1, Math.min(input.backupLimit ?? 25, 100));
  const workspaceLimit = Math.max(1, Math.min(input.workspaceLimit ?? 1, 5));
  const backupResult = await db.execute<{ count: number }>(sql`
    WITH due AS MATERIALIZED (
      SELECT backup."id", backup."organization_id"
      FROM "workspace_control"."workspace_metadata_backup" backup
      WHERE backup."deleted_at" IS NOT NULL
        AND backup."purge_after" <= now()
      ORDER BY backup."purge_after", backup."id"
      LIMIT ${backupLimit}
      FOR UPDATE OF backup SKIP LOCKED
    ), audited AS (
      INSERT INTO "workspace_control"."workspace_audit_event"
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT due."organization_id", NULL, 'workspace.backup.purge',
        'workspace_backup', due."id"::text, '{}'::jsonb, gen_random_uuid()
      FROM due
      RETURNING "resource_id"
    ), deleted AS (
      DELETE FROM "workspace_control"."workspace_metadata_backup" backup
      USING due
      WHERE backup."id" = due."id"
        AND backup."organization_id" = due."organization_id"
        AND backup."purge_after" <= now()
      RETURNING backup."id"
    )
    SELECT count(*)::integer AS "count" FROM deleted
  `);
  const due = await db.execute<{ organizationId: string; receiptId: string }>(sql`
    SELECT profile."organization_id" AS "organizationId",
      profile."deletion_receipt_id"::text AS "receiptId"
    FROM "workspace_control"."workspace_profile" profile
    JOIN "workspace_control"."workspace_deletion_receipt" receipt
      ON receipt."id" = profile."deletion_receipt_id"
     AND receipt."organization_id" = profile."organization_id"
    WHERE profile."lifecycle_state" = 'deletion_pending'
      AND profile."purge_after" <= now()
      AND receipt."status" = 'pending'
      AND receipt."purge_after" <= now()
    ORDER BY profile."purge_after", profile."organization_id"
    LIMIT ${workspaceLimit}
  `);
  let workspacesPurged = 0;
  for (const row of due.rows) {
    const purged = await db.execute<{ purged: boolean }>(sql`
      SELECT "workspace_control"."purge_due_workspace"(
        ${row.organizationId}, ${row.receiptId}::uuid
      ) AS "purged"
    `);
    if (purged.rows[0]?.purged === true) workspacesPurged += 1;
  }
  return {
    backupsPurged: integer(backupResult.rows[0]?.count),
    workspacesPurged,
    workspacesDeferred: due.rows.length - workspacesPurged,
  };
}
