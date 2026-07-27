// Server-side append-only persistence for secretless connection versions. All
// lookups are tenant-scoped so known UUIDs from another workspace reveal nothing.
import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { db } from "./db";
import { revocationGateLockKey } from "./revocation-gates";
import {
  workspaceAuditEvent,
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceResourceConflict,
  workspaceResourceVersion,
} from "./schema";
import {
  canonicalHash,
  connectionVersionPayload,
  type ConnectionVersionPayload,
} from "./workspace-versioning";
import type { WorkspaceMetadataSnapshot } from "./workspace-backup-core";

export type MutationAuthority = {
  sessionId: string;
  userId: string;
  membershipId: string;
  role: string;
};


export async function conflictConnectionCandidate({
  organizationId,
  connectionId,
  expectedRevision,
  payload,
  authority,
  operation = "update",
}: {
  organizationId: string;
  connectionId: string;
  expectedRevision: number;
  payload: ConnectionVersionPayload;
  authority: MutationAuthority;
  operation?: "update" | "delete" | "restore";
}) {
  const candidateId = crypto.randomUUID();
  const conflictId = crypto.randomUUID();
  const result = await db.execute<{ conflictId: string }>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${revocationGateLockKey({
        kind: "member", organizationId, memberId: authority.membershipId, userId: authority.userId,
      })}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id" FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${authority.membershipId} AND member."organization_id" = ${organizationId}
        AND member."user_id" = ${authority.userId}
      JOIN "workspace_control"."workspace_connection_grant" grant
        ON grant."organization_id" = ${organizationId}
        AND grant."connection_id" = ${connectionId}::uuid
        AND grant."member_id" = member."id" AND grant."capability" = 'manage'
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${authority.sessionId} AND session."user_id" = ${authority.userId}
        AND session."expires_at" > now() AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member, grant
    ), locked_connection AS MATERIALIZED (
      SELECT "content_revision" FROM ${workspaceConnection}
      WHERE "organization_id" = ${organizationId} AND "id" = ${connectionId}::uuid
      AND EXISTS (SELECT 1 FROM authority)
      FOR UPDATE
    ), server_version AS MATERIALIZED (
      SELECT version."id", version."revision" FROM ${workspaceResourceVersion} AS version
      JOIN locked_connection ON TRUE
      WHERE version."organization_id" = ${organizationId}
        AND version."resource_type" = 'connection'
        AND version."resource_id" = ${connectionId}::uuid
        AND version."branch" = 'main'
        AND version."revision" = locked_connection."content_revision"
    ), base_version AS MATERIALIZED (
      SELECT "id" FROM ${workspaceResourceVersion}
      WHERE "organization_id" = ${organizationId} AND "resource_type" = 'connection'
        AND "resource_id" = ${connectionId}::uuid AND "branch" = 'main'
        AND "revision" = ${expectedRevision}
    ), candidate AS (
      INSERT INTO ${workspaceResourceVersion}
        ("id", "organization_id", "resource_type", "resource_id", "revision",
         "base_revision", "parent_version_id", "branch", "operation", "payload",
         "payload_hash", "created_by_user_id")
      SELECT ${candidateId}::uuid, ${organizationId}, 'connection', ${connectionId}::uuid,
        ${expectedRevision}, ${expectedRevision}, COALESCE(base_version."id", server_version."id"),
        'conflict', ${operation}, ${JSON.stringify(payload)}::jsonb, ${canonicalHash(payload)},
        ${authority.userId}
      FROM server_version LEFT JOIN base_version ON TRUE
      RETURNING "id"
    ), conflict AS (
      INSERT INTO ${workspaceResourceConflict}
        ("id", "organization_id", "resource_type", "resource_id", "expected_revision",
         "server_version_id", "candidate_version_id", "created_by_user_id")
      SELECT ${conflictId}::uuid, ${organizationId}, 'connection', ${connectionId}::uuid,
        ${expectedRevision}, server_version."id", candidate."id", ${authority.userId}
      FROM server_version JOIN candidate ON TRUE
      RETURNING "id"
    ), audit AS (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${organizationId}, ${authority.userId}, 'connection.conflict.recorded',
        'connection_conflict', conflict."id"::text,
        jsonb_build_object('expectedRevision', ${expectedRevision},
          'serverRevision', server_version."revision"), ${crypto.randomUUID()}::uuid
      FROM conflict JOIN server_version ON TRUE
    ) SELECT conflict."id"::text AS "conflictId" FROM conflict
  `);
  if (!result.rows[0]?.conflictId) {
    throw new Error("Missing immutable connection version");
  }
  return conflictId;
}

export type StoredConnection = Pick<typeof workspaceConnection.$inferSelect,
  "id" | "name" | "engine" | "provider" | "driverId" | "host" | "port" | "databaseName"
  | "sslmode" | "readonlyDefault" | "allowWrites" | "environment" | "schemaGroup"
  | "credentialMode" | "contentRevision" | "updatedAt">;

type RawConnectionRow = Record<string, unknown>;

function safeNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}

export function returnedConnection(row: RawConnectionRow | undefined): StoredConnection | null {
  if (!row) return null;
  const port = safeNumber(row.port);
  const contentRevision = safeNumber(row.contentRevision);
  const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(String(row.updatedAt));
  if (
    typeof row.id !== "string" || typeof row.name !== "string" || typeof row.engine !== "string"
    || typeof row.provider !== "string" || !(typeof row.driverId === "string" || row.driverId === null)
    || typeof row.host !== "string" || port === null || typeof row.databaseName !== "string"
    || typeof row.sslmode !== "string" || typeof row.readonlyDefault !== "boolean"
    || typeof row.allowWrites !== "boolean" || !(typeof row.environment === "string" || row.environment === null)
    || !(typeof row.schemaGroup === "string" || row.schemaGroup === null)
    || typeof row.credentialMode !== "string" || contentRevision === null || contentRevision < 1
    || Number.isNaN(updatedAt.valueOf())
  ) return null;
  return {
    id: row.id, name: row.name, engine: row.engine, provider: row.provider, driverId: row.driverId,
    host: row.host, port, databaseName: row.databaseName, sslmode: row.sslmode,
    readonlyDefault: row.readonlyDefault, allowWrites: row.allowWrites, environment: row.environment,
    schemaGroup: row.schemaGroup, credentialMode: row.credentialMode, contentRevision, updatedAt,
  };
}

export async function commitConnectionCreate({
  organizationId, connectionId, authority, input,
}: {
  organizationId: string;
  connectionId: string;
  authority: MutationAuthority;
  input: ConnectionVersionPayload;
}): Promise<StoredConnection | null> {
  const requestId = crypto.randomUUID();
  const result = await db.execute<RawConnectionRow>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${revocationGateLockKey({
        kind: "member", organizationId, memberId: authority.membershipId, userId: authority.userId,
      })}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id" FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member ON member."id" = ${authority.membershipId}
        AND member."organization_id" = ${organizationId} AND member."user_id" = ${authority.userId}
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${authority.sessionId} AND session."user_id" = ${authority.userId}
        AND session."expires_at" > now() AND member."role" = ${authority.role}
        AND member."role" IN ('admin', 'owner') AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), inserted AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_connection"
        ("id", "organization_id", "name", "engine", "provider", "driver_id", "host", "port",
         "database_name", "sslmode", "readonly_default", "allow_writes", "environment", "schema_group",
         "content_revision", "created_by_user_id")
      SELECT ${connectionId}::uuid, ${organizationId}, ${input.name}, ${input.engine}, ${input.provider},
        ${input.driverId}, ${input.host}, ${input.port}, ${input.database}, ${input.sslmode},
        ${input.readonlyDefault}, ${input.allowWrites}, ${input.env}, ${input.schemaGroup}, 1, ${authority.userId}
      FROM authority
      RETURNING "id" AS "id", "name" AS "name", "engine" AS "engine", "provider" AS "provider",
        "driver_id" AS "driverId", "host" AS "host", "port" AS "port", "database_name" AS "databaseName",
        "sslmode" AS "sslmode", "readonly_default" AS "readonlyDefault", "allow_writes" AS "allowWrites",
        "environment" AS "environment", "schema_group" AS "schemaGroup", "credential_mode" AS "credentialMode",
        "content_revision" AS "contentRevision", "updated_at" AS "updatedAt"
    ), creator_grant AS MATERIALIZED (
      INSERT INTO ${workspaceConnectionGrant}
        ("organization_id", "connection_id", "member_id", "capability")
      SELECT ${organizationId}, inserted."id", ${authority.membershipId}, 'manage'
      FROM inserted
      RETURNING "id"
    ), version AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_resource_version"
        ("id", "organization_id", "resource_type", "resource_id", "revision", "base_revision",
         "parent_version_id", "branch", "operation", "payload", "payload_hash", "created_by_user_id")
      SELECT gen_random_uuid(), ${organizationId}, 'connection', inserted."id", 1, 0, NULL, 'main', 'create',
        ${JSON.stringify(input)}::jsonb, ${canonicalHash(input)}, ${authority.userId}
      FROM inserted JOIN creator_grant ON TRUE RETURNING "id"
    ), audit AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_audit_event"
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id", "redacted_summary", "request_id")
      SELECT ${organizationId}, ${authority.userId}, 'connection.share', 'connection', inserted."id"::text,
        jsonb_build_object('name', inserted."name", 'engine', inserted."engine"), ${requestId}::uuid
      FROM inserted JOIN version ON TRUE RETURNING "id"
    ) SELECT inserted.* FROM inserted JOIN creator_grant ON TRUE JOIN version ON TRUE JOIN audit ON TRUE
  `);
  return returnedConnection(result.rows[0]);
}

export async function commitConnectionMutation({
  organizationId,
  connectionId,
  expectedContentRevision,
  expectedAuthorityRevision,
  claimId,
  authority,
  mutation,
}: {
  organizationId: string;
  connectionId: string;
  expectedContentRevision: number;
  expectedAuthorityRevision: number;
  claimId: string;
  authority: MutationAuthority;
  mutation: {
    kind: "update";
    payload: ConnectionVersionPayload;
    name: string; engine: string; provider: string; driverId: string | null;
    host: string; port: number; databaseName: string; sslmode: string;
    readonlyDefault: boolean; allowWrites: boolean; environment: string | null; schemaGroup: string | null;
  } | {
    kind: "delete";
    payload: ConnectionVersionPayload;
  };
}): Promise<StoredConnection | null> {
  const requestId = crypto.randomUUID();
  const set: SQL = mutation.kind === "update"
    ? sql`"name" = ${mutation.name}, "engine" = ${mutation.engine}, "provider" = ${mutation.provider},
      "driver_id" = ${mutation.driverId}, "host" = ${mutation.host}, "port" = ${mutation.port},
      "database_name" = ${mutation.databaseName}, "sslmode" = ${mutation.sslmode},
      "readonly_default" = ${mutation.readonlyDefault}, "allow_writes" = ${mutation.allowWrites},
      "environment" = ${mutation.environment}, "schema_group" = ${mutation.schemaGroup},
      "revocation_pending_at" = NULL, "revocation_claimed_at" = NULL, "revocation_claim_id" = NULL,
      "content_revision" = "content_revision" + 1, "updated_at" = now()`
    : sql`"deleted_at" = now(), "provider_integration_id" = NULL, "provider_resource" = NULL,
      "provider_resource_id" = NULL, "revocation_pending_at" = NULL, "revocation_claimed_at" = NULL,
      "revocation_claim_id" = NULL, "content_revision" = "content_revision" + 1, "updated_at" = now()`;
  const action = mutation.kind === "update" ? "connection.update" : "connection.delete";
  const operation = mutation.kind;
  const result = await db.execute<RawConnectionRow>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${revocationGateLockKey({
        kind: "member", organizationId, memberId: authority.membershipId, userId: authority.userId,
      })}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id" FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${authority.membershipId} AND member."organization_id" = ${organizationId}
        AND member."user_id" = ${authority.userId}
      JOIN "workspace_control"."workspace_connection_grant" grant
        ON grant."organization_id" = ${organizationId}
        AND grant."connection_id" = ${connectionId}::uuid
        AND grant."member_id" = member."id" AND grant."capability" = 'manage'
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${authority.sessionId} AND session."user_id" = ${authority.userId}
        AND session."expires_at" > now() AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member, grant
    ), parent AS MATERIALIZED (
      SELECT version."id" FROM "workspace_control"."workspace_resource_version" version
      JOIN authority ON TRUE
      WHERE version."organization_id" = ${organizationId} AND version."resource_type" = 'connection'
        AND version."resource_id" = ${connectionId}::uuid AND version."branch" = 'main'
        AND version."revision" = ${expectedContentRevision}
    ), updated AS MATERIALIZED (
      UPDATE "workspace_control"."workspace_connection" connection SET ${set}
      FROM authority, parent
      WHERE connection."id" = ${connectionId}::uuid AND connection."organization_id" = ${organizationId}
        AND connection."content_revision" = ${expectedContentRevision}
        AND connection."revision" = ${expectedAuthorityRevision}
        AND connection."revocation_claim_id" = ${claimId}::uuid AND connection."deleted_at" IS NULL
      RETURNING connection."id" AS "id", connection."name" AS "name", connection."engine" AS "engine",
        connection."provider" AS "provider", connection."driver_id" AS "driverId", connection."host" AS "host",
        connection."port" AS "port", connection."database_name" AS "databaseName", connection."sslmode" AS "sslmode",
        connection."readonly_default" AS "readonlyDefault", connection."allow_writes" AS "allowWrites",
        connection."environment" AS "environment", connection."schema_group" AS "schemaGroup",
        connection."credential_mode" AS "credentialMode", connection."content_revision" AS "contentRevision",
        connection."updated_at" AS "updatedAt"
    ), version AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_resource_version"
        ("id", "organization_id", "resource_type", "resource_id", "revision", "base_revision",
         "parent_version_id", "branch", "operation", "payload", "payload_hash", "created_by_user_id")
      SELECT gen_random_uuid(), ${organizationId}, 'connection', updated."id", updated."content_revision",
        ${expectedContentRevision}, parent."id", 'main', ${operation}, ${JSON.stringify(mutation.payload)}::jsonb,
        ${canonicalHash(mutation.payload)}, ${authority.userId}
      FROM updated JOIN parent ON TRUE
      RETURNING "id"
    ), audit AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_audit_event"
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${organizationId}, ${authority.userId}, ${action}, 'connection', updated."id"::text,
        jsonb_build_object('name', updated."name", 'revision', updated."content_revision"), ${requestId}::uuid
      FROM updated JOIN version ON TRUE
      RETURNING "id"
    ) SELECT updated.* FROM updated JOIN version ON TRUE JOIN audit ON TRUE
  `);
  return returnedConnection(result.rows[0]);
}

/**
 * Applies a decrypted, already validated backup as one PostgreSQL statement.
 * A CTE statement is atomic, so a failed insert, immutable-version violation, or
 * audit failure rolls back the profile CAS and every restore effect together.
 */
export async function restoreWorkspaceSnapshot({
  organizationId,
  backupId,
  expectedRevision,
  sourceRevision,
  authority,
  snapshot,
}: {
  organizationId: string;
  backupId: string;
  expectedRevision: number;
  sourceRevision: number;
  authority: {
    sessionId: string;
    userId: string;
    membershipId: string;
    role: "admin" | "owner";
  };
  snapshot: WorkspaceMetadataSnapshot;
}) {
  const items = snapshot.connections.map((item) => {
    // Historical encrypted snapshots can predate #23's member-local read-only
    // invariant. Their hash was checked before this point; restore creates a new,
    // safe immutable version rather than replaying the obsolete write preference.
    const normalized = {
      ...item,
      readonlyDefault: true,
      allowWrites: false,
    };
    return {
      id: normalized.id,
      content_revision: normalized.contentRevision,
      name: normalized.name,
      engine: normalized.engine,
      provider: normalized.provider,
      driver_id: normalized.driverId,
      host: normalized.host,
      port: normalized.port,
      database_name: normalized.database,
      sslmode: normalized.sslmode,
      readonly_default: normalized.readonlyDefault,
      allow_writes: normalized.allowWrites,
      environment: normalized.env,
      schema_group: normalized.schemaGroup,
      payload: connectionVersionPayload(normalized),
      payload_hash: canonicalHash(connectionVersionPayload(normalized)),
    };
  });
  const result = await db.execute<{
    revision: number;
    restored: number;
    conflictIds: string[];
  }>(sql`
    WITH input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS item(
        "id" uuid, "content_revision" bigint, "name" text, "engine" text,
        "provider" text, "driver_id" text, "host" text, "port" integer,
        "database_name" text, "sslmode" text, "readonly_default" boolean,
        "allow_writes" boolean, "environment" text, "schema_group" text,
        "payload" jsonb, "payload_hash" text
      )
    ), authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${revocationGateLockKey({
          kind: "member",
          organizationId,
          memberId: authority.membershipId,
          userId: authority.userId,
        })}, 0
      ))
    ), authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${authority.membershipId}
        AND member."organization_id" = ${organizationId}
        AND member."user_id" = ${authority.userId}
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${authority.sessionId}
        AND session."user_id" = ${authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${authority.role}
        AND member."role" IN ('admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), backup_gate AS MATERIALIZED (
      SELECT backup."id"
      FROM "workspace_control"."workspace_metadata_backup" backup
      JOIN authority ON TRUE
      WHERE backup."id" = ${backupId}::uuid
        AND backup."organization_id" = ${organizationId}
        AND backup."deleted_at" IS NULL
        AND backup."source_revision" = ${sourceRevision}
      FOR UPDATE OF backup
    ), profile_gate AS MATERIALIZED (
      SELECT profile."organization_id"
      FROM "workspace_control"."workspace_profile" profile
      JOIN backup_gate ON TRUE
      WHERE profile."organization_id" = ${organizationId}
        AND profile."revision" = ${expectedRevision}
      FOR UPDATE OF profile
    ), existing AS MATERIALIZED (
      SELECT item.*, connection."content_revision" AS "server_revision"
      FROM input item
      JOIN "workspace_control"."workspace_connection" connection
        ON connection."organization_id" = ${organizationId} AND connection."id" = item."id"
      JOIN profile_gate ON TRUE
      FOR UPDATE OF connection
    ), server_versions AS MATERIALIZED (
      SELECT existing.*, version."id" AS "server_version_id", base."id" AS "base_version_id"
      FROM existing
      JOIN "workspace_control"."workspace_resource_version" version
        ON version."organization_id" = ${organizationId}
        AND version."resource_type" = 'connection' AND version."resource_id" = existing."id"
        AND version."branch" = 'main' AND version."revision" = existing."server_revision"
      LEFT JOIN "workspace_control"."workspace_resource_version" base
        ON base."organization_id" = ${organizationId}
        AND base."resource_type" = 'connection' AND base."resource_id" = existing."id"
        AND base."branch" = 'main' AND base."revision" = existing."content_revision"
    ), coverage AS MATERIALIZED (
      SELECT 1 FROM profile_gate
      WHERE NOT EXISTS (
        SELECT 1 FROM input item
        LEFT JOIN existing ON existing."id" = item."id"
        LEFT JOIN server_versions ON server_versions."id" = item."id"
        WHERE existing."id" IS NOT NULL AND server_versions."server_version_id" IS NULL
      )
    ), claimed AS MATERIALIZED (
      UPDATE "workspace_control"."workspace_profile"
      SET "revision" = "revision" + 1, "updated_at" = now()
      FROM coverage
      WHERE "organization_id" = ${organizationId} AND "revision" = ${expectedRevision}
      RETURNING "revision"
    ), candidates AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_resource_version"
        ("id", "organization_id", "resource_type", "resource_id", "revision", "base_revision",
         "parent_version_id", "branch", "operation", "payload", "payload_hash", "created_by_user_id")
      SELECT gen_random_uuid(), ${organizationId}, 'connection', "id", "content_revision",
        "content_revision", COALESCE("base_version_id", "server_version_id"), 'conflict', 'restore',
        "payload", "payload_hash", ${authority.userId}
      FROM server_versions
      JOIN claimed ON TRUE
      RETURNING "id", "resource_id"
    ), conflicts AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_resource_conflict"
        ("id", "organization_id", "resource_type", "resource_id", "expected_revision",
         "server_version_id", "candidate_version_id", "created_by_user_id")
      SELECT gen_random_uuid(), ${organizationId}, 'connection', candidate."resource_id",
        server."content_revision", server."server_version_id", candidate."id", ${authority.userId}
      FROM candidates candidate
      JOIN server_versions server ON server."id" = candidate."resource_id"
      RETURNING "id"
    ), missing AS MATERIALIZED (
      SELECT input.* FROM input
      LEFT JOIN existing ON existing."id" = input."id"
      JOIN claimed ON TRUE
      WHERE existing."id" IS NULL
    ), inserted AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_connection"
        ("id", "organization_id", "name", "engine", "provider", "driver_id", "host", "port",
         "database_name", "sslmode", "readonly_default", "allow_writes", "environment", "schema_group",
         "content_revision", "created_by_user_id")
      SELECT "id", ${organizationId}, "name", "engine", "provider", "driver_id", "host", "port",
        "database_name", "sslmode", "readonly_default", "allow_writes", "environment", "schema_group",
        "content_revision", ${authority.userId}
      FROM missing
      RETURNING "id"
    ), restored_grants AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_connection_grant"
        ("organization_id", "connection_id", "member_id", "capability")
      SELECT ${organizationId}, inserted."id", ${authority.membershipId}, 'manage'
      FROM inserted
      ON CONFLICT ("organization_id", "connection_id", "member_id") DO NOTHING
      RETURNING "connection_id"
    ), created_versions AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_resource_version"
        ("id", "organization_id", "resource_type", "resource_id", "revision", "base_revision",
         "parent_version_id", "branch", "operation", "payload", "payload_hash", "created_by_user_id")
      SELECT gen_random_uuid(), ${organizationId}, 'connection', missing."id", missing."content_revision",
        missing."content_revision" - 1, NULL, 'main', 'restore', missing."payload", missing."payload_hash",
        ${authority.userId}
      FROM missing JOIN inserted ON inserted."id" = missing."id"
      JOIN restored_grants ON restored_grants."connection_id" = inserted."id"
    ), audit AS MATERIALIZED (
      INSERT INTO "workspace_control"."workspace_audit_event"
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${organizationId}, ${authority.userId}, 'workspace.backup.restore', 'workspace_backup', ${backupId},
        jsonb_build_object('created', (SELECT count(*) FROM inserted),
          'conflictCount', (SELECT count(*) FROM conflicts), 'sourceRevision', ${sourceRevision}),
        gen_random_uuid()
      FROM claimed
    )
    SELECT claimed."revision"::bigint AS "revision", (SELECT count(*) FROM inserted)::int AS "restored",
      COALESCE((SELECT array_agg(conflict."id"::text) FROM conflicts conflict), ARRAY[]::text[]) AS "conflictIds"
    FROM claimed
  `);
  return result.rows[0] ?? null;
}
