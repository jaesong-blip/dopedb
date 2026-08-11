// Run status and terminal completion. Completion validates every receipt against
// the immutable Article revision, encrypts bounded fragments, then commits all
// evidence and the terminal state atomically.
import { and, eq } from "drizzle-orm";

import { db } from "../../../../../../../../../lib/db";
import { env } from "../../../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../../lib/http";
import {
  workspaceAnalysisArticle,
  workspaceAnalysisArticleQueryReceipt,
  workspaceAnalysisArticleRevision,
  workspaceAnalysisArticleRun,
} from "../../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../../lib/workspace-authorization";
import { accessibleAnalysisArticle } from "../../../../../../../../../lib/workspace-analysis-article-http";
import {
  commitAnalysisRunCompletion,
  type AnalysisRunAuthority,
} from "../../../../../../../../../lib/workspace-analysis-run-store";
import { sealAnalysisResultFragments } from "../../../../../../../../../lib/workspace-analysis-results";
import { parseAnalysisRunCompletion } from "../../../../../../../../../lib/workspace-analysis-runs";
import {
  analysisBlockResultColumns,
  parseAnalysisArticleVersionPayload,
} from "../../../../../../../../../lib/workspace-analysis-articles";
import { hasWorkspaceCapability } from "../../../../../../../../../lib/workspace-permissions";
import { canonicalHash } from "../../../../../../../../../lib/workspace-versioning";

type RouteContext = {
  params: Promise<{ workspaceId: string; articleId: string; runId: string }>;
};

function authority(authorization: {
  role: string;
  session: { session: { id: string }; user: { id: string } };
  membership: { id: string };
}): AnalysisRunAuthority {
  return {
    sessionId: authorization.session.session.id,
    userId: authorization.session.user.id,
    membershipId: authorization.membership.id,
    role: authorization.role,
  };
}

function publicRun(run: typeof workspaceAnalysisArticleRun.$inferSelect) {
  return {
    ...run,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
  };
}

async function runRevision(workspaceId: string, articleId: string, revision: number) {
  const row = await db.query.workspaceAnalysisArticleRevision.findFirst({
    where: and(
      eq(workspaceAnalysisArticleRevision.organizationId, workspaceId),
      eq(workspaceAnalysisArticleRevision.articleId, articleId),
      eq(workspaceAnalysisArticleRevision.revision, revision),
    ),
    columns: { payload: true },
  });
  if (!row) return null;
  try {
    const payload = parseAnalysisArticleVersionPayload(row.payload);
    return payload.deleted ? null : payload;
  } catch {
    return null;
  }
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, articleId, runId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(runId)) {
    return jsonError("Invalid Analysis Article run scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const accessible = await accessibleAnalysisArticle({
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
  if (!accessible) return jsonError("Analysis Article not found", 404);
  const run = await db.query.workspaceAnalysisArticleRun.findFirst({
    where: and(
      eq(workspaceAnalysisArticleRun.organizationId, workspaceId),
      eq(workspaceAnalysisArticleRun.articleId, articleId),
      eq(workspaceAnalysisArticleRun.id, runId),
    ),
  });
  if (!run) return jsonError("Analysis Article run not found", 404);
  const receipts = await db.select({
    queryNodeId: workspaceAnalysisArticleQueryReceipt.queryNodeId,
    state: workspaceAnalysisArticleQueryReceipt.state,
    rowCount: workspaceAnalysisArticleQueryReceipt.rowCount,
    byteCount: workspaceAnalysisArticleQueryReceipt.byteCount,
    durationMs: workspaceAnalysisArticleQueryReceipt.durationMs,
    schemaFingerprint: workspaceAnalysisArticleQueryReceipt.schemaFingerprint,
  }).from(workspaceAnalysisArticleQueryReceipt).where(and(
    eq(workspaceAnalysisArticleQueryReceipt.organizationId, workspaceId),
    eq(workspaceAnalysisArticleQueryReceipt.runId, runId),
  ));
  return privateJson({ run: publicRun(run), receipts });
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, articleId, runId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(runId)) {
    return jsonError("Invalid Analysis Article run scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const run = await db.query.workspaceAnalysisArticleRun.findFirst({
    where: and(
      eq(workspaceAnalysisArticleRun.organizationId, workspaceId),
      eq(workspaceAnalysisArticleRun.articleId, articleId),
      eq(workspaceAnalysisArticleRun.id, runId),
    ),
  });
  if (!run) return jsonError("Analysis Article run not found", 404);
  if (run.state !== "running") return jsonError("Analysis Article run is already terminal", 409);
  const revision = await runRevision(workspaceId, articleId, run.articleRevision);
  if (!revision) return jsonError("Analysis Article revision is unavailable", 409);
  const articleProjection = await db.query.workspaceAnalysisArticle.findFirst({
    where: and(
      eq(workspaceAnalysisArticle.organizationId, workspaceId),
      eq(workspaceAnalysisArticle.id, articleId),
    ),
    columns: { revision: true, state: true, liveRevision: true, deletedAt: true },
  });
  if (!articleProjection || articleProjection.deletedAt) {
    return jsonError("Analysis Article is unavailable", 409);
  }
  const body = await boundedJsonBody(request, 17 * 1024 * 1024);
  if (!body.ok) return jsonError("Invalid Analysis Article completion", 400);
  let completion;
  try {
    completion = parseAnalysisRunCompletion(body.value, revision.definition);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid Analysis Article completion", 400);
  }
  const connectionByRole = new Map(revision.connections.map((connection) => [connection.role, connection]));
  const queryById = new Map(revision.definition.queries.map((query) => [query.id, query]));
  for (const receipt of completion.queryReceipts) {
    const query = queryById.get(receipt.queryNodeId);
    const connection = query ? connectionByRole.get(query.connectionRole) : null;
    if (!query || !connection || receipt.connectionId !== connection.connectionId
      || receipt.connectionRevision !== connection.connectionRevision
      || receipt.queryHash !== canonicalHash({ sql: query.sql, parameterValues: run.parameterValues })) {
      return jsonError("Analysis Article query receipt does not match the immutable revision", 409);
    }
  }
  const blockById = new Map(revision.definition.blocks.map((block) => [block.id, block]));
  for (const fragment of completion.fragments) {
    const block = blockById.get(fragment.blockId);
    let columns;
    try {
      columns = block ? analysisBlockResultColumns(revision.definition, block) : null;
    } catch {
      columns = null;
    }
    if (!columns?.length || canonicalHash(fragment.columns) !== canonicalHash(columns)) {
      return jsonError("Analysis Article result schema does not match its block source", 409);
    }
  }
  const mayStoreSharedResults = articleProjection.liveRevision === run.articleRevision
    || (articleProjection.revision === run.articleRevision && articleProjection.state === "review");
  if (completion.fragments.length > 0 && !mayStoreSharedResults) {
    return jsonError(
      "Draft run results stay on Desktop until the Article enters review",
      409,
    );
  }
  const expiresAt = new Date(
    Date.now() + revision.definition.refresh.resultRetentionDays * 24 * 60 * 60 * 1_000,
  );
  const sealedFragments = completion.fragments.length === 0 ? [] : await sealAnalysisResultFragments({
    request,
    workspaceId,
    actorUserId: authorization.session.user.id,
    runId,
    expiresAt,
    fragments: completion.fragments,
  });
  const updated = await commitAnalysisRunCompletion({
    organizationId: workspaceId,
    articleId,
    runId,
    runnerId: run.runnerId,
    completion,
    sealedFragments,
    authority: authority(authorization),
  });
  if (!updated) return jsonError("Analysis run authority changed before completion", 409);
  return privateJson({ run: updated });
}
