import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../../../../../lib/db";
import { env } from "../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../lib/http";
import { workspaceSignalRule } from "../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../lib/workspace-authorization";
import { hasWorkspaceCapability } from "../../../../../../lib/workspace-permissions";
import { commitSignalRuleCreate } from "../../../../../../lib/workspace-signal-store";
import { parseSignalRuleCreate } from "../../../../../../lib/workspace-signals";
import { parseExpectedRevision } from "../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const rules = await db.select().from(workspaceSignalRule).where(and(
    eq(workspaceSignalRule.organizationId, workspaceId),
    isNull(workspaceSignalRule.deletedAt),
    sql`(${workspaceSignalRule.ownerMemberId} = ${authorization.membership.id}
      OR ${workspaceSignalRule.definition}->'recipientMemberIds'
        @> ${JSON.stringify([authorization.membership.id])}::jsonb)`,
  )).orderBy(desc(workspaceSignalRule.updatedAt), desc(workspaceSignalRule.id));
  return privateJson({
    workspaceId,
    rules: rules.map((rule) => ({
      id: rule.id,
      projectEnvironmentId: rule.projectEnvironmentId,
      environmentRevision: rule.environmentRevision,
      sourceAnalysisId: rule.sourceAnalysisId,
      sourceAnalysisRevision: rule.sourceAnalysisRevision,
      sourceTileId: rule.sourceTileId,
      metricSemanticId: rule.metricSemanticId,
      definition: rule.definition,
      ownerMemberId: rule.ownerMemberId,
      runnerId: rule.runnerId,
      enabled: rule.enabled,
      revision: rule.revision,
      nextEvaluationAt: rule.nextEvaluationAt.toISOString(),
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    })),
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Signal rule creation requires workspace Editor access", 403);
  }
  let expectedRevision: number | null;
  try {
    expectedRevision = parseExpectedRevision(request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid If-Match", 400);
  }
  if (expectedRevision !== 0) return jsonError("New signal rules require If-Match: \"0\"", 409);
  const body = await boundedJsonBody(request, 64 * 1024);
  if (!body.ok) return jsonError("Invalid signal rule request", 400);
  let rule;
  try {
    rule = parseSignalRuleCreate(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid signal rule", 400);
  }
  try {
    const stored = await commitSignalRuleCreate({
      organizationId: workspaceId,
      rule,
      authority: {
        sessionId: authorization.session.session.id,
        userId: authorization.session.user.id,
        membershipId: authorization.membership.id,
        role: authorization.role,
      },
    });
    if (!stored) {
      return jsonError(
        "Signal authority changed. Refresh the published analysis, Environment grants, recipients, and runner.",
        409,
      );
    }
    return privateJson({ rule: stored }, { status: 201 });
  } catch (error) {
    const row = error && typeof error === "object"
      ? error as { code?: unknown; cause?: { code?: unknown } }
      : null;
    if (row?.code === "23505" || row?.cause?.code === "23505") {
      return jsonError("Signal rule already exists", 409);
    }
    throw error;
  }
}
