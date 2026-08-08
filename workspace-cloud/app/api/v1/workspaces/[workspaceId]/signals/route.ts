import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "../../../../../../lib/db";
import { env } from "../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../lib/http";
import {
  workspaceSignalEvaluationReceipt,
  workspaceSignalRule,
  workspaceSignalRunner,
} from "../../../../../../lib/schema";
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
  const ruleIds = rules.map((rule) => rule.id);
  const receipts = ruleIds.length > 0
    ? await db.select({
        id: workspaceSignalEvaluationReceipt.id,
        ruleId: workspaceSignalEvaluationReceipt.ruleId,
        state: workspaceSignalEvaluationReceipt.state,
        observedState: workspaceSignalEvaluationReceipt.observedState,
        evaluatedAt: workspaceSignalEvaluationReceipt.evaluatedAt,
        transitionSequence: workspaceSignalEvaluationReceipt.transitionSequence,
        errorKind: workspaceSignalEvaluationReceipt.errorKind,
      }).from(workspaceSignalEvaluationReceipt).where(and(
        eq(workspaceSignalEvaluationReceipt.organizationId, workspaceId),
        inArray(workspaceSignalEvaluationReceipt.ruleId, ruleIds),
      )).orderBy(
        desc(workspaceSignalEvaluationReceipt.transitionSequence),
        desc(workspaceSignalEvaluationReceipt.id),
      )
    : [];
  const latestReceipt = new Map<string, (typeof receipts)[number]>();
  for (const receipt of receipts) {
    if (!latestReceipt.has(receipt.ruleId)) latestReceipt.set(receipt.ruleId, receipt);
  }
  const runnerIds = rules.flatMap((rule) => rule.runnerId ? [rule.runnerId] : []);
  const runners = runnerIds.length > 0
    ? await db.select({
        id: workspaceSignalRunner.id,
        displayName: workspaceSignalRunner.displayName,
        backgroundAllowed: workspaceSignalRunner.backgroundAllowed,
        lastSeenAt: workspaceSignalRunner.lastSeenAt,
        revokedAt: workspaceSignalRunner.revokedAt,
      }).from(workspaceSignalRunner).where(and(
        eq(workspaceSignalRunner.organizationId, workspaceId),
        inArray(workspaceSignalRunner.id, runnerIds),
      ))
    : [];
  const runnerById = new Map(runners.map((runner) => [runner.id, runner]));
  return privateJson({
    workspaceId,
    rules: rules.map((rule) => {
      const receipt = latestReceipt.get(rule.id) ?? null;
      const runner = rule.runnerId ? runnerById.get(rule.runnerId) ?? null : null;
      const runnerOnline = Boolean(
        runner && !runner.revokedAt && runner.lastSeenAt.getTime() > Date.now() - 120_000,
      );
      return {
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
      status: rule.status,
      revision: rule.revision,
      nextEvaluationAt: rule.nextEvaluationAt.toISOString(),
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
      latestEvaluation: receipt ? {
        id: receipt.id,
        state: receipt.state,
        observedState: receipt.observedState,
        evaluatedAt: receipt.evaluatedAt.toISOString(),
        transitionSequence: receipt.transitionSequence,
        errorKind: receipt.errorKind,
      } : null,
      runner: runner ? {
        id: runner.id,
        displayName: runner.displayName,
        backgroundAllowed: runner.backgroundAllowed,
        lastSeenAt: runner.lastSeenAt.toISOString(),
        online: runnerOnline,
      } : null,
      actuallyMonitoring: rule.enabled && runnerOnline,
    };
    }),
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
