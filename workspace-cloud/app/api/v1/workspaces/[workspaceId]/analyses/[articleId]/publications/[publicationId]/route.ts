// Revoke one fixed publication without deleting its immutable audit evidence.
import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "../../../../../../../../../lib/db";
import { env } from "../../../../../../../../../lib/env";
import { isUuid, jsonError, mutationAllowed, privateJson } from "../../../../../../../../../lib/http";
import {
  workspaceAnalysisArticle,
  workspaceAnalysisPublication,
  workspaceAuditEvent,
} from "../../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../../lib/workspace-authorization";
import { hasWorkspaceCapability } from "../../../../../../../../../lib/workspace-permissions";

type RouteContext = {
  params: Promise<{ workspaceId: string; articleId: string; publicationId: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, articleId, publicationId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(publicationId)) {
    return jsonError("Invalid Analysis Article publication scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "write");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Analysis Article publication revocation requires Editor access", 403);
  }
  const requestId = crypto.randomUUID();
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH authority AS MATERIALIZED (
      SELECT article."id"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${authorization.membership.id}
       AND member."organization_id" = ${workspaceId}
       AND member."user_id" = ${authorization.session.user.id}
      JOIN ${workspaceAnalysisArticle} article
        ON article."organization_id" = member."organization_id"
       AND article."id" = ${articleId}::uuid
       AND (article."owner_member_id" = member."id" OR member."role" IN ('admin', 'owner'))
      WHERE session."id" = ${authorization.session.session.id}
        AND session."user_id" = ${authorization.session.user.id}
        AND session."expires_at" > now()
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member, article
    ), revoked AS MATERIALIZED (
      UPDATE ${workspaceAnalysisPublication} publication
      SET "revoked_at" = COALESCE(publication."revoked_at", now())
      FROM authority
      WHERE publication."organization_id" = ${workspaceId}
        AND publication."article_id" = authority."id"
        AND publication."id" = ${publicationId}::uuid
      RETURNING publication."id", publication."slug", publication."revoked_at"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${workspaceId}, ${authorization.session.user.id}, 'analysis_publication.revoke',
        'analysis_publication', revoked."id"::text, '{}'::jsonb, ${requestId}::uuid
      FROM revoked RETURNING "resource_id"
    )
    SELECT revoked."id"::text AS "id", revoked."slug" AS "slug",
      revoked."revoked_at" AS "revokedAt"
    FROM revoked JOIN audit ON audit."resource_id" = revoked."id"::text
  `);
  const row = result.rows[0];
  if (!row) return jsonError("Analysis Article publication not found", 404);
  const revokedAt = row.revokedAt instanceof Date ? row.revokedAt : new Date(String(row.revokedAt));
  if (typeof row.slug !== "string") return jsonError("Analysis Article publication is invalid", 409);
  revalidatePath(`/analyses/${row.slug}`);
  revalidatePath(`/api/v1/public/analyses/${row.slug}`);
  return privateJson({ id: row.id, revokedAt: revokedAt.toISOString() });
}
