// Desktop submits only categorical signal evidence for an exact successful
// Article run. No measured value is accepted or returned here.
import { and, desc, eq } from "drizzle-orm";

import { db } from "../../../../../../../../../../lib/db";
import { env } from "../../../../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../../../lib/http";
import {
  workspaceAnalysisArticleRevision,
  workspaceAnalysisSignal,
  workspaceAnalysisSignalReceipt,
} from "../../../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../../../lib/workspace-authorization";
import { accessibleAnalysisArticle } from "../../../../../../../../../../lib/workspace-analysis-article-http";
import {
  analysisRunnerCapabilityHeader,
  hashAnalysisRunnerCapability,
  isAnalysisDesktopBearerRequest,
  parseAnalysisRunnerCapability,
} from "../../../../../../../../../../lib/workspace-analysis-runner-capability";
import {
  commitAnalysisSignalReceipt,
  type AnalysisSignalAuthority,
} from "../../../../../../../../../../lib/workspace-analysis-signal-store";
import {
  analysisBlockResultColumns,
  parseAnalysisArticleVersionPayload,
} from "../../../../../../../../../../lib/workspace-analysis-articles";
import { parseAnalysisSignalReceipt } from "../../../../../../../../../../lib/workspace-analysis-signals";
import { hasWorkspaceCapability } from "../../../../../../../../../../lib/workspace-permissions";
import { canonicalHash } from "../../../../../../../../../../lib/workspace-versioning";

type RouteContext = {
  params: Promise<{ workspaceId: string; articleId: string; signalId: string }>;
};

function authority(authorization: {
  role: string;
  session: { session: { id: string }; user: { id: string } };
  membership: { id: string };
}): AnalysisSignalAuthority {
  return {
    sessionId: authorization.session.session.id,
    userId: authorization.session.user.id,
    membershipId: authorization.membership.id,
    role: authorization.role,
  };
}

function exactReceiptEnvelope(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || !("runnerId" in row) || !("receipt" in row)
    || typeof row.runnerId !== "string" || !isUuid(row.runnerId)) return null;
  return { runnerId: row.runnerId, receipt: row.receipt };
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, articleId, signalId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(signalId)) {
    return jsonError("Invalid Analysis signal receipt scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const article = await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: hasWorkspaceCapability(authorization.role, "write"),
  }) ?? await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: false,
  });
  if (!article) return jsonError("Analysis Article not found", 404);
  const signal = await db.query.workspaceAnalysisSignal.findFirst({
    where: and(
      eq(workspaceAnalysisSignal.organizationId, workspaceId),
      eq(workspaceAnalysisSignal.articleId, articleId),
      eq(workspaceAnalysisSignal.id, signalId),
    ),
    columns: { id: true, enabled: true, articleRevision: true, deletedAt: true },
  });
  if (!signal || signal.deletedAt || (!hasWorkspaceCapability(authorization.role, "write")
    && (!signal.enabled || signal.articleRevision !== article.liveRevision))) {
    return jsonError("Analysis signal not found", 404);
  }
  const rows = await db.select({
    id: workspaceAnalysisSignalReceipt.id,
    signalRevision: workspaceAnalysisSignalReceipt.signalRevision,
    runId: workspaceAnalysisSignalReceipt.runId,
    observedState: workspaceAnalysisSignalReceipt.observedState,
    state: workspaceAnalysisSignalReceipt.state,
    resultHash: workspaceAnalysisSignalReceipt.resultHash,
    schemaFingerprint: workspaceAnalysisSignalReceipt.schemaFingerprint,
    transitionSequence: workspaceAnalysisSignalReceipt.transitionSequence,
    errorKind: workspaceAnalysisSignalReceipt.errorKind,
    evaluatedAt: workspaceAnalysisSignalReceipt.evaluatedAt,
    createdAt: workspaceAnalysisSignalReceipt.createdAt,
  }).from(workspaceAnalysisSignalReceipt).where(and(
    eq(workspaceAnalysisSignalReceipt.organizationId, workspaceId),
    eq(workspaceAnalysisSignalReceipt.signalId, signalId),
  )).orderBy(desc(workspaceAnalysisSignalReceipt.transitionSequence)).limit(200);
  return privateJson({
    receipts: rows.map((row) => ({
      ...row,
      evaluatedAt: row.evaluatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  if (!isAnalysisDesktopBearerRequest(request)) {
    return jsonError("Analysis signal evaluation requires a Desktop bearer session", 401);
  }
  const { workspaceId, articleId, signalId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(signalId)) {
    return jsonError("Invalid Analysis signal receipt scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const runnerCapability = parseAnalysisRunnerCapability(request);
  if (!runnerCapability) return jsonError(
    "Invalid Analysis runner capability",
    request.headers.has(analysisRunnerCapabilityHeader) ? 403 : 428,
  );
  const runnerCapabilityHash = hashAnalysisRunnerCapability(runnerCapability);
  const body = await boundedJsonBody(request, 32 * 1024);
  const envelope = body.ok ? exactReceiptEnvelope(body.value) : null;
  if (!envelope) return jsonError("Invalid Analysis signal receipt", 400);
  let receipt;
  try {
    receipt = parseAnalysisSignalReceipt(envelope.receipt);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid Analysis signal receipt", 400);
  }
  if (receipt.dedupeKey !== `analysis-signal:${signalId}:${receipt.signalRevision}:${receipt.runId}`) {
    return jsonError("Analysis signal receipt idempotency key is invalid", 400);
  }
  const signal = await db.query.workspaceAnalysisSignal.findFirst({
    where: and(
      eq(workspaceAnalysisSignal.organizationId, workspaceId),
      eq(workspaceAnalysisSignal.articleId, articleId),
      eq(workspaceAnalysisSignal.id, signalId),
    ),
  });
  if (!signal || signal.deletedAt || !signal.enabled || signal.revision !== receipt.signalRevision) {
    return jsonError("Analysis signal revision is no longer active", 409);
  }
  const revision = await db.query.workspaceAnalysisArticleRevision.findFirst({
    where: and(
      eq(workspaceAnalysisArticleRevision.organizationId, workspaceId),
      eq(workspaceAnalysisArticleRevision.articleId, articleId),
      eq(workspaceAnalysisArticleRevision.revision, signal.articleRevision),
    ),
    columns: { payload: true },
  });
  if (!revision) return jsonError("Analysis Article revision is unavailable", 409);
  let expectedSchemaFingerprint;
  try {
    const article = parseAnalysisArticleVersionPayload(revision.payload);
    if (article.deleted) throw new Error("Deleted Analysis Article revision");
    const block = article.definition.blocks.find((candidate) => candidate.id === signal.blockId);
    if (!block || block.kind !== "metric") throw new Error("Invalid signal block");
    expectedSchemaFingerprint = canonicalHash(
      analysisBlockResultColumns(article.definition, block),
    );
  } catch {
    return jsonError("Analysis signal block is unavailable in its pinned revision", 409);
  }
  try {
    const stored = await commitAnalysisSignalReceipt({
      organizationId: workspaceId,
      articleId,
      signalId,
      runnerId: envelope.runnerId,
      runnerCapabilityHash,
      expectedSchemaFingerprint,
      receipt,
      authority: authority(authorization),
    });
    if (!stored) return jsonError("Analysis signal evidence no longer has exact authority", 409);
    return privateJson({
      receipt: {
        ...stored,
        notificationCount: Number(stored.notificationCount),
        evaluatedAt: stored.evaluatedAt instanceof Date
          ? stored.evaluatedAt.toISOString() : stored.evaluatedAt,
        createdAt: stored.createdAt instanceof Date
          ? stored.createdAt.toISOString() : stored.createdAt,
      },
    }, { status: 201 });
  } catch (error) {
    const row = error && typeof error === "object"
      ? error as { code?: unknown; cause?: { code?: unknown } } : null;
    if (row?.code === "23505" || row?.cause?.code === "23505") {
      return jsonError("Analysis signal receipt was already accepted", 409);
    }
    throw error;
  }
}
