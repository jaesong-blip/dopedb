// Decrypt reviewed internal Analysis Article fragments for authorized workspace
// members. Viewers receive only the run pinned to the current live revision;
// editors may inspect historical run evidence for review and recovery.
import { and, asc, eq, gt } from "drizzle-orm";

import { db } from "../../../../../../../../../../lib/db";
import { isUuid, jsonError, privateJson } from "../../../../../../../../../../lib/http";
import {
  workspaceAnalysisArticleRun,
  workspaceAnalysisResultFragment,
} from "../../../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../../../lib/workspace-authorization";
import { accessibleAnalysisArticle } from "../../../../../../../../../../lib/workspace-analysis-article-http";
import { openAnalysisResultFragments } from "../../../../../../../../../../lib/workspace-analysis-results";
import { hasWorkspaceCapability } from "../../../../../../../../../../lib/workspace-permissions";

type RouteContext = {
  params: Promise<{ workspaceId: string; articleId: string; runId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, articleId, runId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(runId)) {
    return jsonError("Invalid Analysis Article result scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const canEdit = hasWorkspaceCapability(authorization.role, "write");
  const article = await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: canEdit,
  }) ?? await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: false,
  });
  if (!article) return jsonError("Analysis Article not found", 404);
  if (!canEdit && article.liveRunId !== runId) {
    return jsonError("Analysis Article result is not the current live result", 404);
  }
  const run = await db.query.workspaceAnalysisArticleRun.findFirst({
    where: and(
      eq(workspaceAnalysisArticleRun.organizationId, workspaceId),
      eq(workspaceAnalysisArticleRun.articleId, articleId),
      eq(workspaceAnalysisArticleRun.id, runId),
      eq(workspaceAnalysisArticleRun.state, "succeeded"),
    ),
  });
  if (!run) return jsonError("Analysis Article result not found", 404);
  const stored = await db.select().from(workspaceAnalysisResultFragment).where(and(
    eq(workspaceAnalysisResultFragment.organizationId, workspaceId),
    eq(workspaceAnalysisResultFragment.runId, runId),
    gt(workspaceAnalysisResultFragment.expiresAt, new Date()),
  )).orderBy(
    asc(workspaceAnalysisResultFragment.blockId),
    asc(workspaceAnalysisResultFragment.ordinal),
  );
  try {
    const fragments = await openAnalysisResultFragments({
      request,
      workspaceId,
      fragments: stored.map((fragment) => ({
        runId,
        blockId: fragment.blockId,
        ordinal: fragment.ordinal,
        dataKeyId: fragment.dataKeyId,
        keyReference: fragment.keyReference,
        keyVersion: fragment.keyVersion,
        ciphertext: fragment.ciphertext,
        payloadHash: fragment.payloadHash,
      })),
    });
    return privateJson({
      run: {
        id: run.id,
        articleId: run.articleId,
        articleRevision: run.articleRevision,
        state: run.state,
        resultHash: run.resultHash,
        rowCount: run.rowCount,
        byteCount: run.byteCount,
        finishedAt: run.finishedAt?.toISOString() ?? null,
      },
      fragments,
    });
  } catch {
    return jsonError("Analysis Article result is temporarily unavailable", 503);
  }
}
