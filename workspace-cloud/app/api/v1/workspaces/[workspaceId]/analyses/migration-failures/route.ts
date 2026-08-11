// Editor-only recovery inventory for definitions archived during the one-way
// Analysis Article migration. Payloads may contain source SQL and are never
// exposed to viewers or executed by this route.
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "../../../../../../../lib/db";
import { env } from "../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../lib/http";
import { workspaceAnalysisMigrationFailure } from "../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";
import { resolveAnalysisMigrationFailure } from "../../../../../../../lib/workspace-analysis-migration-store";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "write");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const includeResolved = new URL(request.url).searchParams.get("includeResolved") === "true";
  const rows = await db.select().from(workspaceAnalysisMigrationFailure).where(and(
    eq(workspaceAnalysisMigrationFailure.organizationId, workspaceId),
    includeResolved ? undefined : isNull(workspaceAnalysisMigrationFailure.resolvedAt),
  )).orderBy(
    desc(workspaceAnalysisMigrationFailure.archivedAt),
    desc(workspaceAnalysisMigrationFailure.id),
  ).limit(500);
  return privateJson({
    failures: rows.map((row) => ({
      ...row,
      originalCreatedAt: row.originalCreatedAt?.toISOString() ?? null,
      archivedAt: row.archivedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    })),
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "write");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const parsed = await boundedJsonBody(request, 8 * 1024);
  const body = parsed.ok && parsed.value && typeof parsed.value === "object"
    && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : null;
  if (!body || Object.keys(body).length !== 2
    || typeof body.failureId !== "string" || !isUuid(body.failureId)
    || typeof body.articleId !== "string" || !isUuid(body.articleId)) {
    return jsonError("Invalid Analysis migration resolution", 400);
  }
  const resolved = await resolveAnalysisMigrationFailure({
    organizationId: workspaceId,
    failureId: body.failureId,
    articleId: body.articleId,
    authority: {
      sessionId: authorization.session.session.id,
      userId: authorization.session.user.id,
      membershipId: authorization.membership.id,
      role: authorization.role,
    },
  });
  if (!resolved) return jsonError("Migration failure or replacement Article changed", 409);
  return privateJson({ resolved });
}
