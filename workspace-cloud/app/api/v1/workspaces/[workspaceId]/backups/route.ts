// Admin-only ciphertext backup inventory. Public responses deliberately expose only
// backup metadata; plaintext and envelope bytes never cross this boundary.
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../../../../../lib/db";
import { env } from "../../../../../../lib/env";
import { isUuid, jsonError, mutationAllowed, privateJson } from "../../../../../../lib/http";
import {
  workspaceAuditEvent,
  workspaceConnection,
  workspaceMetadataBackup,
  workspaceProfile,
} from "../../../../../../lib/schema";
import {
  sealWorkspaceMetadataBackup,
  snapshotHash,
  WORKSPACE_BACKUP_KEY_REFERENCE,
  WORKSPACE_BACKUP_KEY_VERSION,
} from "../../../../../../lib/workspace-backup";
import { authorizeWorkspace } from "../../../../../../lib/workspace-authorization";
import { revocationGateLockKey } from "../../../../../../lib/revocation-gates";
import { parseSharedConnection } from "../../../../../../lib/workspace-connections";

type RouteContext = { params: Promise<{ workspaceId: string }> };

type BackupMetadata = {
  id: string;
  sourceRevision: number;
  keyReference: string;
  keyVersion: string;
  snapshotHash: string;
  createdAt: string;
};

type ReturnedBackupRow = {
  id: unknown;
  sourceRevision: unknown;
  keyReference: unknown;
  keyVersion: unknown;
  snapshotHash: unknown;
  createdAt: unknown;
};

function backupMetadata(row: typeof workspaceMetadataBackup.$inferSelect) {
  return {
    id: row.id,
    sourceRevision: row.sourceRevision,
    keyReference: row.keyReference,
    keyVersion: row.keyVersion,
    snapshotHash: row.snapshotHash,
    createdAt: row.createdAt.toISOString(),
  };
}

// db.execute returns driver rows, unlike Drizzle's mapped select rows. Validate the
// explicit RETURNING aliases before a driver int8/timestamptz can cross this boundary.
function returnedBackupMetadata(row: ReturnedBackupRow): BackupMetadata | null {
  const sourceRevision = typeof row.sourceRevision === "number"
    ? row.sourceRevision
    : typeof row.sourceRevision === "string" ? Number(row.sourceRevision) : NaN;
  const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt));
  if (
    typeof row.id !== "string"
    || !isUuid(row.id)
    || !Number.isSafeInteger(sourceRevision)
    || sourceRevision < 1
    || row.keyReference !== WORKSPACE_BACKUP_KEY_REFERENCE
    || row.keyVersion !== WORKSPACE_BACKUP_KEY_VERSION
    || typeof row.snapshotHash !== "string"
    || !/^[a-f0-9]{64}$/i.test(row.snapshotHash)
    || Number.isNaN(createdAt.valueOf())
  ) return null;
  return {
    id: row.id,
    sourceRevision,
    keyReference: row.keyReference,
    keyVersion: row.keyVersion,
    snapshotHash: row.snapshotHash,
    createdAt: createdAt.toISOString(),
  };
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (authorization.role !== "admin" && authorization.role !== "owner") {
    return jsonError("Workspace access denied", 403);
  }
  const backups = await db.select().from(workspaceMetadataBackup).where(and(
    eq(workspaceMetadataBackup.organizationId, workspaceId),
    isNull(workspaceMetadataBackup.deletedAt),
  )).orderBy(desc(workspaceMetadataBackup.createdAt));
  await db.insert(workspaceAuditEvent).values({
    organizationId: workspaceId,
    actorUserId: authorization.session.user.id,
    action: "workspace.backup.list",
    resourceType: "workspace_backup",
    redactedSummary: { count: backups.length },
    requestId: crypto.randomUUID(),
  });
  return privateJson({ workspaceId, backups: backups.map(backupMetadata) });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const [profile, connections] = await Promise.all([
    db.query.workspaceProfile.findFirst({
      where: eq(workspaceProfile.organizationId, workspaceId),
    }),
    db.select({
      id: workspaceConnection.id,
      contentRevision: workspaceConnection.contentRevision,
      name: workspaceConnection.name,
      engine: workspaceConnection.engine,
      provider: workspaceConnection.provider,
      driverId: workspaceConnection.driverId,
      host: workspaceConnection.host,
      port: workspaceConnection.port,
      database: workspaceConnection.databaseName,
      sslmode: workspaceConnection.sslmode,
      readonlyDefault: workspaceConnection.readonlyDefault,
      allowWrites: workspaceConnection.allowWrites,
      env: workspaceConnection.environment,
      schemaGroup: workspaceConnection.schemaGroup,
      credentialMode: workspaceConnection.credentialMode,
      providerIntegrationId: workspaceConnection.providerIntegrationId,
      providerResource: workspaceConnection.providerResource,
    }).from(workspaceConnection).where(and(
      eq(workspaceConnection.organizationId, workspaceId),
      isNull(workspaceConnection.deletedAt),
    )),
  ]);
  if (!profile) return jsonError("Workspace metadata is unavailable", 409);
  const snapshot = {
    version: 1 as const,
    workspace: {
      organizationId: workspaceId,
      lifecycleState: profile.lifecycleState,
      residencyRegion: profile.residencyRegion,
      revision: profile.revision,
    },
    connections: connections.map(({
      id,
      contentRevision,
      credentialMode,
      providerIntegrationId: _providerIntegrationId,
      providerResource: _providerResource,
      ...connection
    }) => ({
      id,
      contentRevision,
      ...parseSharedConnection(connection, {
        credentialMode: credentialMode === "managed" ? "managed" : "member_local",
      }),
    })),
  };
  const backupId = crypto.randomUUID();
  const ciphertext = sealWorkspaceMetadataBackup(workspaceId, backupId, snapshot);
  const snapshotConnections = connections.map((connection) => ({
    id: connection.id,
    content_revision: connection.contentRevision,
    name: connection.name,
    engine: connection.engine,
    provider: connection.provider,
    driver_id: connection.driverId,
    host: connection.host,
    port: connection.port,
    database_name: connection.database,
    sslmode: connection.sslmode,
    readonly_default: connection.readonlyDefault,
    allow_writes: connection.allowWrites,
    environment: connection.env,
    schema_group: connection.schemaGroup,
    credential_mode: connection.credentialMode,
    provider_integration_id: connection.providerIntegrationId,
    provider_resource: connection.providerResource,
  }));
  const result = await db.execute<ReturnedBackupRow>(sql`
    WITH authority_lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${revocationGateLockKey({
        kind: "member", organizationId: workspaceId, memberId: authorization.membership.id,
        userId: authorization.session.user.id,
      })}, 0))
    ), authority AS (
      SELECT member."id" FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member ON member."id" = ${authorization.membership.id}
        AND member."organization_id" = ${workspaceId} AND member."user_id" = ${authorization.session.user.id}
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${authorization.session.session.id} AND session."user_id" = ${authorization.session.user.id}
        AND session."expires_at" > now() AND member."role" = ${authorization.role}
        AND member."role" IN ('admin', 'owner') AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), profile_snapshot AS MATERIALIZED (
      SELECT profile."organization_id", profile."revision"
      FROM "workspace_control"."workspace_profile" profile
      JOIN authority ON TRUE
      WHERE profile."organization_id" = ${workspaceId}
        AND profile."revision" = ${profile.revision}
        AND profile."lifecycle_state" IS NOT DISTINCT FROM ${profile.lifecycleState}
        AND profile."residency_region" IS NOT DISTINCT FROM ${profile.residencyRegion}
      FOR UPDATE OF profile
    ), supplied_connections AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(snapshotConnections)}::jsonb) AS supplied(
        "id" uuid, "content_revision" bigint, "name" text, "engine" text,
        "provider" text, "driver_id" text, "host" text, "port" integer,
        "database_name" text, "sslmode" text, "readonly_default" boolean,
        "allow_writes" boolean, "environment" text, "schema_group" text,
        "credential_mode" text, "provider_integration_id" uuid, "provider_resource" jsonb
      )
    ), current_connections AS MATERIALIZED (
      SELECT connection."id", connection."content_revision", connection."name",
        connection."engine", connection."provider", connection."driver_id",
        connection."host", connection."port", connection."database_name",
        connection."sslmode", connection."readonly_default", connection."allow_writes",
        connection."environment", connection."schema_group", connection."credential_mode",
        connection."provider_integration_id", connection."provider_resource"
      FROM "workspace_control"."workspace_connection" connection
      JOIN profile_snapshot ON TRUE
      WHERE connection."organization_id" = ${workspaceId}
        AND connection."deleted_at" IS NULL
      FOR UPDATE OF connection
    ), snapshot_matches AS MATERIALIZED (
      SELECT 1 FROM profile_snapshot
      WHERE NOT EXISTS (
        (SELECT * FROM supplied_connections)
        EXCEPT
        (SELECT * FROM current_connections)
      )
      AND NOT EXISTS (
        (SELECT * FROM current_connections)
        EXCEPT
        (SELECT * FROM supplied_connections)
      )
    ), inserted AS (
      INSERT INTO "workspace_control"."workspace_metadata_backup"
        ("id", "organization_id", "source_revision", "key_reference", "key_version", "ciphertext", "snapshot_hash", "created_by_user_id")
      SELECT ${backupId}::uuid, ${workspaceId}, ${profile.revision}, ${WORKSPACE_BACKUP_KEY_REFERENCE},
        ${WORKSPACE_BACKUP_KEY_VERSION}, ${ciphertext}, ${snapshotHash(snapshot)}, ${authorization.session.user.id}
      FROM snapshot_matches
      RETURNING "id" AS "id", "source_revision" AS "sourceRevision",
        "key_reference" AS "keyReference", "key_version" AS "keyVersion",
        "snapshot_hash" AS "snapshotHash", "created_at" AS "createdAt"
    ), audit AS (
      INSERT INTO "workspace_control"."workspace_audit_event"
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id", "redacted_summary", "request_id")
      SELECT ${workspaceId}, ${authorization.session.user.id}, 'workspace.backup.create', 'workspace_backup',
        inserted."id"::text, jsonb_build_object('connectionCount', ${snapshot.connections.length}, 'sourceRevision', ${profile.revision}), gen_random_uuid()
      FROM inserted RETURNING "id"
    ) SELECT inserted.* FROM inserted JOIN audit ON TRUE
  `);
  const backup = result.rows[0] && returnedBackupMetadata(result.rows[0]);
  if (!backup) return jsonError("Workspace metadata changed concurrently. Retry backup.", 409);
  return privateJson({ backup }, { status: 201 });
}
