// Backup retention tombstones are admin-only and scoped by workspace id, preventing
// a known backup UUID from disclosing or deleting another tenant's ciphertext.
import { sql } from "drizzle-orm";

import { db } from "../../../../../../../lib/db";
import { env } from "../../../../../../../lib/env";
import { isUuid, jsonError, mutationAllowed } from "../../../../../../../lib/http";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";
import { revocationGateLockKey } from "../../../../../../../lib/revocation-gates";

type RouteContext = { params: Promise<{ workspaceId: string; backupId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, backupId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(backupId)) return jsonError("Invalid workspace or backup id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (authorization.role !== "admin" && authorization.role !== "owner") {
    return jsonError("Workspace access denied", 403);
  }
  const result = await db.execute<{ id: string }>(sql`
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
    ), deleted AS (
      UPDATE "workspace_control"."workspace_metadata_backup"
      SET "deleted_at" = now()
      FROM authority
      WHERE "id" = ${backupId}::uuid AND "organization_id" = ${workspaceId}
        AND "deleted_at" IS NULL
      RETURNING "id"
    ), audit AS (
      INSERT INTO "workspace_control"."workspace_audit_event"
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${workspaceId}, ${authorization.session.user.id}, 'workspace.backup.delete',
        'workspace_backup', deleted."id"::text, '{}'::jsonb, gen_random_uuid()
      FROM deleted
    ) SELECT "id"::text AS "id" FROM deleted
  `);
  if (!result.rows[0]) return jsonError("Backup not found", 404);
  return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
}
