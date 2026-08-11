// Approval-gated fixed public Analysis Article snapshots.
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import { revocationGateLockKey } from "./revocation-gates";
import {
  workspaceAnalysisArticle,
  workspaceAnalysisArticleRun,
  workspaceAnalysisPublication,
  workspaceAuditEvent,
} from "./schema";
import type { AnalysisRunAuthority } from "./workspace-analysis-run-store";
import type {
  AnalysisPublicationRequest,
  AnalysisPublicSnapshot,
} from "./workspace-analysis-publications";
import { canonicalHash } from "./workspace-versioning";

export async function commitAnalysisPublication(input: {
  organizationId: string;
  articleId: string;
  articleRevision: number;
  request: AnalysisPublicationRequest;
  snapshot: AnalysisPublicSnapshot;
  authority: AnalysisRunAuthority;
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
    ), source AS MATERIALIZED (
      SELECT article."id", article."live_revision", run."id" AS "run_id"
      FROM ${workspaceAnalysisArticle} article
      JOIN ${workspaceAnalysisArticleRun} run
        ON run."organization_id" = article."organization_id"
       AND run."article_id" = article."id"
       AND run."id" = article."live_run_id"
       AND run."id" = ${input.request.runId}::uuid
       AND run."state" = 'succeeded'
      JOIN authority ON TRUE
      WHERE article."organization_id" = ${input.organizationId}
        AND article."id" = ${input.articleId}::uuid
        AND article."live_revision" = ${input.articleRevision}
        AND article."deleted_at" IS NULL
        AND (article."owner_member_id" = authority."id" OR authority."role" IN ('admin', 'owner'))
      FOR UPDATE OF article, run
    ), previous_publication AS MATERIALIZED (
      SELECT previous."id", previous."version"
      FROM ${workspaceAnalysisPublication} previous
      JOIN source ON source."id" = previous."article_id"
      WHERE previous."organization_id" = ${input.organizationId}
        AND previous."id" = ${input.request.replacePublicationId}::uuid
        AND previous."slug" = ${input.request.slug}
        AND previous."revoked_at" IS NULL
      FOR UPDATE OF previous
    ), publication_slot AS MATERIALIZED (
      SELECT NULL::uuid AS "previous_id", 1::bigint AS "next_version"
      FROM source
      WHERE ${input.request.replacePublicationId}::uuid IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceAnalysisPublication} active
          WHERE active."slug" = ${input.request.slug}
            AND active."revoked_at" IS NULL
        )
      UNION ALL
      SELECT previous."id", previous."version" + 1
      FROM previous_publication previous
    ), revoked AS MATERIALIZED (
      UPDATE ${workspaceAnalysisPublication} previous SET "revoked_at" = now()
      FROM publication_slot
      WHERE previous."organization_id" = ${input.organizationId}
        AND previous."id" = publication_slot."previous_id"
      RETURNING previous."id"
    ), inserted AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisPublication}
        ("id", "organization_id", "article_id", "article_revision", "source_run_id",
         "slug", "version", "replaces_publication_id", "visibility", "title",
         "description", "snapshot", "snapshot_hash", "approved_by_member_id")
      SELECT ${input.request.id}::uuid, ${input.organizationId}, source."id",
        source."live_revision", source."run_id", ${input.request.slug},
        publication_slot."next_version", publication_slot."previous_id",
        ${input.request.visibility}, ${input.request.title}, ${input.request.description},
        ${JSON.stringify(input.snapshot)}::jsonb, ${canonicalHash(input.snapshot)}, authority."id"
      FROM source JOIN authority ON TRUE JOIN publication_slot ON TRUE
      WHERE publication_slot."previous_id" IS NULL
        OR EXISTS (SELECT 1 FROM revoked WHERE revoked."id" = publication_slot."previous_id")
      RETURNING *
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'analysis_publication.create',
        'analysis_publication', inserted."id"::text,
        jsonb_build_object('articleId', inserted."article_id", 'articleRevision',
          inserted."article_revision", 'visibility', inserted."visibility",
          'version', inserted."version"), ${requestId}::uuid
      FROM inserted RETURNING "resource_id"
    )
    SELECT inserted."id"::text AS "id", inserted."slug" AS "slug",
      inserted."version" AS "version", inserted."visibility" AS "visibility",
      inserted."snapshot_hash" AS "snapshotHash",
      inserted."published_at" AS "publishedAt"
    FROM inserted JOIN audit ON audit."resource_id" = inserted."id"::text
  `);
  return result.rows[0] ?? null;
}
