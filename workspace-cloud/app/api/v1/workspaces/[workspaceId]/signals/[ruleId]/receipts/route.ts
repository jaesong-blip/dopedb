import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../../../../../../../lib/db";
import { isUuid, jsonError, privateJson } from "../../../../../../../../lib/http";
import {
  workspaceSignalEvaluationReceipt,
  workspaceSignalRule,
} from "../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string; ruleId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, ruleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(ruleId)) return jsonError("Invalid signal scope", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const rows = await db.select({
    id: workspaceSignalEvaluationReceipt.id,
    ruleRevision: workspaceSignalEvaluationReceipt.ruleRevision,
    environmentRevision: workspaceSignalEvaluationReceipt.environmentRevision,
    scheduledAt: workspaceSignalEvaluationReceipt.scheduledAt,
    evaluatedAt: workspaceSignalEvaluationReceipt.evaluatedAt,
    observedState: workspaceSignalEvaluationReceipt.observedState,
    state: workspaceSignalEvaluationReceipt.state,
    queryRunIds: workspaceSignalEvaluationReceipt.queryRunIds,
    connectionIds: workspaceSignalEvaluationReceipt.connectionIds,
    durationMs: workspaceSignalEvaluationReceipt.durationMs,
    rowCountCategory: workspaceSignalEvaluationReceipt.rowCountCategory,
    schemaFingerprint: workspaceSignalEvaluationReceipt.schemaFingerprint,
    transitionSequence: workspaceSignalEvaluationReceipt.transitionSequence,
    errorKind: workspaceSignalEvaluationReceipt.errorKind,
  }).from(workspaceSignalEvaluationReceipt).innerJoin(workspaceSignalRule, and(
    eq(workspaceSignalRule.organizationId, workspaceSignalEvaluationReceipt.organizationId),
    eq(workspaceSignalRule.id, workspaceSignalEvaluationReceipt.ruleId),
  )).where(and(
    eq(workspaceSignalEvaluationReceipt.organizationId, workspaceId),
    eq(workspaceSignalEvaluationReceipt.ruleId, ruleId),
    isNull(workspaceSignalRule.deletedAt),
    sql`(${workspaceSignalRule.ownerMemberId} = ${authorization.membership.id}
      OR ${workspaceSignalRule.definition}->'recipientMemberIds'
        @> ${JSON.stringify([authorization.membership.id])}::jsonb)`,
  )).orderBy(desc(workspaceSignalEvaluationReceipt.transitionSequence)).limit(100);
  return privateJson({
    workspaceId,
    ruleId,
    receipts: rows.map((row) => ({
      ...row,
      scheduledAt: row.scheduledAt.toISOString(),
      evaluatedAt: row.evaluatedAt.toISOString(),
    })),
  });
}
