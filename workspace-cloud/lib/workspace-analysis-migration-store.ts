// Explicit recovery bookkeeping for one-way legacy BI archives. Resolution
// never executes or rewrites the archived payload: it only binds a separately
// reviewed Analysis Article created through the normal exact-authority path.
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import { revocationGateLockKey } from "./revocation-gates";
import {
  member,
  workspaceAnalysisArticle,
  workspaceAnalysisMigrationFailure,
  workspaceAuditEvent,
} from "./schema";

export type AnalysisMigrationAuthority = Readonly<{
  sessionId: string;
  userId: string;
  membershipId: string;
  role: string;
}>;

export async function resolveAnalysisMigrationFailure(input: {
  organizationId: string;
  failureId: string;
  articleId: string;
  authority: AnalysisMigrationAuthority;
}) {
  const lockKey = revocationGateLockKey({
    kind: "member",
    organizationId: input.organizationId,
    memberId: input.authority.membershipId,
    userId: input.authority.userId,
  });
  const requestId = crypto.randomUUID();
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."session" session
      JOIN ${member} member
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
    ), article_authority AS MATERIALIZED (
      SELECT article."id"
      FROM ${workspaceAnalysisArticle} article
      JOIN authority ON TRUE
      WHERE article."organization_id" = ${input.organizationId}
        AND article."id" = ${input.articleId}::uuid
        AND article."deleted_at" IS NULL
      FOR UPDATE OF article
    ), resolved AS MATERIALIZED (
      UPDATE ${workspaceAnalysisMigrationFailure} failure
      SET "resolved_article_id" = article_authority."id",
        "resolved_by_member_id" = authority."id",
        "resolved_at" = now()
      FROM authority, article_authority
      WHERE failure."organization_id" = ${input.organizationId}
        AND failure."id" = ${input.failureId}::uuid
        AND failure."resolved_at" IS NULL
      RETURNING failure."id", failure."source_kind", failure."source_id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        'analysis_migration_failure.resolve', 'analysis_migration_failure',
        resolved."id"::text,
        jsonb_build_object('sourceKind', resolved."source_kind",
          'sourceId', resolved."source_id", 'articleId', ${input.articleId}::uuid),
        ${requestId}::uuid
      FROM resolved
      RETURNING "resource_id"
    )
    SELECT resolved."id"::text AS "id",
      ${input.articleId}::text AS "articleId"
    FROM resolved JOIN audit ON audit."resource_id" = resolved."id"::text
  `);
  const row = result.rows[0];
  return row && typeof row.id === "string" && typeof row.articleId === "string"
    ? { id: row.id, articleId: row.articleId }
    : null;
}
