// Atomic persistence for shared dashboard definitions. Every mutation rechecks
// the current session, membership, connection grant, dashboard owner, and exact
// revision inside the same PostgreSQL statement that writes history and audit.
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import { revocationGateLockKey } from "./revocation-gates";
import {
  workspaceAuditEvent,
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceDashboard,
  workspaceDashboardRevision,
} from "./schema";
import {
  dashboardVersionPayload,
  type DashboardState,
  type DashboardVersionPayload,
  type SharedDashboardCreate,
  type SharedDashboardDefinition,
} from "./workspace-dashboards";
import { canonicalHash } from "./workspace-versioning";

export type DashboardMutationAuthority = Readonly<{
  sessionId: string;
  userId: string;
  membershipId: string;
  role: string;
}>;

export type StoredDashboard = Readonly<{
  id: string;
  connectionId: string;
  title: string;
  description: string;
  sql: string;
  visualization: unknown;
  state: string;
  ownerMemberId: string;
  updatedByMemberId: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}>;

type RawDashboardRow = Record<string, unknown>;

function safeRevision(value: unknown) {
  const revision = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

export function returnedDashboard(row: RawDashboardRow | undefined): StoredDashboard | null {
  if (!row) return null;
  const revision = safeRevision(row.revision);
  const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt));
  const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(String(row.updatedAt));
  if (
    typeof row.id !== "string"
    || typeof row.connectionId !== "string"
    || typeof row.title !== "string"
    || typeof row.description !== "string"
    || typeof row.sql !== "string"
    || typeof row.state !== "string"
    || typeof row.ownerMemberId !== "string"
    || typeof row.updatedByMemberId !== "string"
    || revision === null
    || Number.isNaN(createdAt.valueOf())
    || Number.isNaN(updatedAt.valueOf())
  ) return null;
  return {
    id: row.id,
    connectionId: row.connectionId,
    title: row.title,
    description: row.description,
    sql: row.sql,
    visualization: row.visualization,
    state: row.state,
    ownerMemberId: row.ownerMemberId,
    updatedByMemberId: row.updatedByMemberId,
    revision,
    createdAt,
    updatedAt,
  };
}

function memberLockKey(input: {
  organizationId: string;
  authority: DashboardMutationAuthority;
}) {
  return revocationGateLockKey({
    kind: "member",
    organizationId: input.organizationId,
    memberId: input.authority.membershipId,
    userId: input.authority.userId,
  });
}

function dashboardColumns() {
  return sql`
    dashboard."id"::text AS "id",
    dashboard."connection_id"::text AS "connectionId",
    dashboard."title" AS "title",
    dashboard."description" AS "description",
    dashboard."sql" AS "sql",
    dashboard."visualization" AS "visualization",
    dashboard."state" AS "state",
    dashboard."owner_member_id" AS "ownerMemberId",
    dashboard."updated_by_member_id" AS "updatedByMemberId",
    dashboard."revision" AS "revision",
    dashboard."created_at" AS "createdAt",
    dashboard."updated_at" AS "updatedAt"`;
}

export async function commitDashboardCreate(input: {
  organizationId: string;
  dashboard: SharedDashboardCreate;
  authority: DashboardMutationAuthority;
  operation?: "create" | "conflict_copy";
  sourceDashboardId?: string | null;
}): Promise<StoredDashboard | null> {
  const operation = input.operation ?? "create";
  const payload = dashboardVersionPayload({
    connectionId: input.dashboard.connectionId,
    definition: input.dashboard,
    state: "draft",
    ownerMemberId: input.authority.membershipId,
  });
  const requestId = crypto.randomUUID();
  const result = await db.execute<RawDashboardRow>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${memberLockKey(input)}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN ${workspaceConnectionGrant} AS connection_grant
        ON connection_grant."organization_id" = ${input.organizationId}
       AND connection_grant."connection_id" = ${input.dashboard.connectionId}::uuid
       AND connection_grant."member_id" = member."id"
       AND connection_grant."capability" IN ('use', 'manage')
      JOIN ${workspaceConnection} AS connection
        ON connection."organization_id" = connection_grant."organization_id"
       AND connection."id" = connection_grant."connection_id"
       AND connection."deleted_at" IS NULL
       AND connection."revocation_pending_at" IS NULL
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."role" IN ('editor', 'admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member, connection_grant, connection
    ), inserted AS MATERIALIZED (
      INSERT INTO ${workspaceDashboard} AS dashboard
        ("id", "organization_id", "connection_id", "title", "description", "sql",
         "visualization", "state", "owner_member_id", "updated_by_member_id", "revision")
      SELECT ${input.dashboard.id}::uuid, ${input.organizationId},
        ${input.dashboard.connectionId}::uuid, ${input.dashboard.title},
        ${input.dashboard.description}, ${input.dashboard.sql},
        ${JSON.stringify(input.dashboard.visualization)}::jsonb, 'draft', authority."id",
        authority."id", 1
      FROM authority
      RETURNING dashboard.*
    ), revision AS MATERIALIZED (
      INSERT INTO ${workspaceDashboardRevision}
        ("organization_id", "dashboard_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_user_id", "created_by_member_id")
      SELECT ${input.organizationId}, inserted."id", 1, 0, ${operation},
        ${JSON.stringify(payload)}::jsonb, ${canonicalHash(payload)},
        ${input.authority.userId}, ${input.authority.membershipId}
      FROM inserted
      RETURNING "dashboard_id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        ${operation === "conflict_copy" ? "dashboard.conflict.duplicated" : "dashboard.share"},
        'dashboard', inserted."id"::text,
        jsonb_build_object(
          'connectionId', inserted."connection_id",
          'title', inserted."title",
          'state', inserted."state",
          'revision', inserted."revision",
          'sourceDashboardId', ${input.sourceDashboardId ?? null}::text
        ), ${requestId}::uuid
      FROM inserted JOIN revision ON revision."dashboard_id" = inserted."id"
      RETURNING "resource_id"
    )
    SELECT ${dashboardColumns()}
    FROM inserted dashboard
    JOIN audit ON audit."resource_id" = dashboard."id"::text
  `);
  return returnedDashboard(result.rows[0]);
}

export type DashboardMutationOperation =
  | "update"
  | "publish"
  | "archive"
  | "restore"
  | "transfer"
  | "delete";

export async function commitDashboardMutation(input: {
  organizationId: string;
  dashboardId: string;
  connectionId: string;
  expectedRevision: number;
  definition: SharedDashboardDefinition;
  state: DashboardState;
  ownerMemberId: string;
  authority: DashboardMutationAuthority;
  operation: DashboardMutationOperation;
}): Promise<StoredDashboard | null> {
  const deleted = input.operation === "delete";
  const payload: DashboardVersionPayload = dashboardVersionPayload({
    connectionId: input.connectionId,
    definition: input.definition,
    state: input.state,
    ownerMemberId: input.ownerMemberId,
    deleted,
  });
  const nextRevision = input.expectedRevision + 1;
  if (!Number.isSafeInteger(nextRevision) || nextRevision > 9_007_199_254_740_991) {
    throw new Error("Invalid dashboard revision");
  }
  const requestId = crypto.randomUUID();
  const result = await db.execute<RawDashboardRow>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${memberLockKey(input)}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id", member."role"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."role" IN ('editor', 'admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), target_owner AS MATERIALIZED (
      SELECT owner."id"
      FROM "workspace_control"."member" owner
      JOIN authority ON TRUE
      WHERE owner."organization_id" = ${input.organizationId}
        AND owner."id" = ${input.ownerMemberId}
        AND owner."role" IN ('editor', 'admin', 'owner')
        AND owner."revocation_pending_at" IS NULL
        AND owner."revocation_claim_id" IS NULL
      FOR UPDATE OF owner
    ), current AS MATERIALIZED (
      SELECT dashboard."id", dashboard."organization_id"
      FROM ${workspaceDashboard} AS dashboard
      JOIN authority ON TRUE
      JOIN target_owner ON TRUE
      JOIN ${workspaceConnectionGrant} AS connection_grant
        ON connection_grant."organization_id" = dashboard."organization_id"
       AND connection_grant."connection_id" = dashboard."connection_id"
       AND connection_grant."member_id" = authority."id"
       AND connection_grant."capability" IN ('use', 'manage')
      JOIN ${workspaceConnection} AS connection
        ON connection."organization_id" = dashboard."organization_id"
       AND connection."id" = dashboard."connection_id"
       AND connection."deleted_at" IS NULL
       AND connection."revocation_pending_at" IS NULL
      WHERE dashboard."organization_id" = ${input.organizationId}
        AND dashboard."id" = ${input.dashboardId}::uuid
        AND dashboard."connection_id" = ${input.connectionId}::uuid
        AND dashboard."revision" = ${input.expectedRevision}
        AND dashboard."deleted_at" IS NULL
        AND (dashboard."owner_member_id" = authority."id"
          OR authority."role" IN ('admin', 'owner'))
      FOR UPDATE OF dashboard, connection_grant, connection
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceDashboard} AS dashboard
      SET "title" = ${input.definition.title},
        "description" = ${input.definition.description},
        "sql" = ${input.definition.sql},
        "visualization" = ${JSON.stringify(input.definition.visualization)}::jsonb,
        "state" = ${input.state},
        "owner_member_id" = ${input.ownerMemberId},
        "updated_by_member_id" = ${input.authority.membershipId},
        "revision" = dashboard."revision" + 1,
        "updated_at" = now(),
        "deleted_at" = CASE WHEN ${deleted} THEN now() ELSE NULL END
      FROM current
      WHERE dashboard."organization_id" = current."organization_id"
        AND dashboard."id" = current."id"
        AND dashboard."revision" = ${input.expectedRevision}
      RETURNING dashboard.*
    ), revision AS MATERIALIZED (
      INSERT INTO ${workspaceDashboardRevision}
        ("organization_id", "dashboard_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_user_id", "created_by_member_id")
      SELECT ${input.organizationId}, updated."id", updated."revision",
        ${input.expectedRevision}, ${input.operation}, ${JSON.stringify(payload)}::jsonb,
        ${canonicalHash(payload)}, ${input.authority.userId}, ${input.authority.membershipId}
      FROM updated
      RETURNING "dashboard_id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        ${`dashboard.${input.operation}`}, 'dashboard', updated."id"::text,
        jsonb_build_object(
          'connectionId', updated."connection_id",
          'title', updated."title",
          'state', updated."state",
          'revision', updated."revision",
          'ownerMemberId', updated."owner_member_id"
        ), ${requestId}::uuid
      FROM updated JOIN revision ON revision."dashboard_id" = updated."id"
      RETURNING "resource_id"
    )
    SELECT ${dashboardColumns()}
    FROM updated dashboard
    JOIN audit ON audit."resource_id" = dashboard."id"::text
  `);
  const dashboard = returnedDashboard(result.rows[0]);
  if (dashboard && dashboard.revision !== nextRevision) {
    throw new Error("Dashboard revision did not advance exactly once");
  }
  return dashboard;
}
