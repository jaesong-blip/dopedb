// Create and list explicitly approved fixed public snapshots of one live Article.
import { and, desc, eq, gt } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "../../../../../../../../lib/db";
import { env } from "../../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../lib/http";
import {
  workspaceAnalysisArticleRun,
  workspaceAnalysisPublication,
  workspaceAnalysisResultFragment,
} from "../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";
import { accessibleAnalysisArticle } from "../../../../../../../../lib/workspace-analysis-article-http";
import { commitAnalysisPublication } from "../../../../../../../../lib/workspace-analysis-publication-store";
import {
  buildAnalysisPublicSnapshot,
  parseAnalysisPublicationRequest,
} from "../../../../../../../../lib/workspace-analysis-publications";
import { openAnalysisResultFragments } from "../../../../../../../../lib/workspace-analysis-results";
import { hasWorkspaceCapability } from "../../../../../../../../lib/workspace-permissions";
import { canonicalHash } from "../../../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ workspaceId: string; articleId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, articleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId)) {
    return jsonError("Invalid Analysis Article publication scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const article = await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: hasWorkspaceCapability(authorization.role, "write"),
  });
  if (!article) return jsonError("Analysis Article not found", 404);
  const rows = await db.select({
    id: workspaceAnalysisPublication.id,
    articleRevision: workspaceAnalysisPublication.articleRevision,
    sourceRunId: workspaceAnalysisPublication.sourceRunId,
    slug: workspaceAnalysisPublication.slug,
    version: workspaceAnalysisPublication.version,
    replacesPublicationId: workspaceAnalysisPublication.replacesPublicationId,
    visibility: workspaceAnalysisPublication.visibility,
    title: workspaceAnalysisPublication.title,
    description: workspaceAnalysisPublication.description,
    snapshotHash: workspaceAnalysisPublication.snapshotHash,
    publishedAt: workspaceAnalysisPublication.publishedAt,
    revokedAt: workspaceAnalysisPublication.revokedAt,
  }).from(workspaceAnalysisPublication).where(and(
    eq(workspaceAnalysisPublication.organizationId, workspaceId),
    eq(workspaceAnalysisPublication.articleId, articleId),
  )).orderBy(desc(workspaceAnalysisPublication.publishedAt));
  return privateJson({
    publications: rows.map((row) => ({
      ...row,
      publishedAt: row.publishedAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    })),
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, articleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId)) {
    return jsonError("Invalid Analysis Article publication scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "write");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Analysis Article publishing requires workspace Editor access", 403);
  }
  const body = await boundedJsonBody(request, 16 * 1024);
  if (!body.ok) return jsonError("Invalid Analysis Article publication", 400);
  let publication;
  try {
    publication = parseAnalysisPublicationRequest(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid Analysis Article publication", 400);
  }
  if (!publication.previewHash) {
    return jsonError("Preview the exact Analysis Article snapshot before publishing", 428);
  }
  const article = await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: false,
  });
  if (!article || !article.liveRevision || article.liveRunId !== publication.runId) {
    return jsonError("Only the current live Analysis Article result can be published", 409);
  }
  const run = await db.query.workspaceAnalysisArticleRun.findFirst({
    where: and(
      eq(workspaceAnalysisArticleRun.organizationId, workspaceId),
      eq(workspaceAnalysisArticleRun.articleId, articleId),
      eq(workspaceAnalysisArticleRun.id, publication.runId),
      eq(workspaceAnalysisArticleRun.state, "succeeded"),
    ),
  });
  if (!run || !run.finishedAt) return jsonError("Live Analysis Article result is unavailable", 409);
  const stored = await db.select().from(workspaceAnalysisResultFragment).where(and(
    eq(workspaceAnalysisResultFragment.organizationId, workspaceId),
    eq(workspaceAnalysisResultFragment.runId, run.id),
    gt(workspaceAnalysisResultFragment.expiresAt, new Date()),
  ));
  let fragments;
  try {
    fragments = await openAnalysisResultFragments({
      request,
      workspaceId,
      fragments: stored.map((fragment) => ({
        runId: run.id,
        blockId: fragment.blockId,
        ordinal: fragment.ordinal,
        dataKeyId: fragment.dataKeyId,
        keyReference: fragment.keyReference,
        keyVersion: fragment.keyVersion,
        ciphertext: fragment.ciphertext,
        payloadHash: fragment.payloadHash,
      })),
    });
  } catch {
    return jsonError("Live Analysis Article result is temporarily unavailable", 503);
  }
  let snapshot;
  try {
    snapshot = buildAnalysisPublicSnapshot({
      request: publication,
      definition: article.definition,
      parameterValues: run.parameterValues as Record<string, string | number | boolean | null>,
      fragments,
      dataAsOf: run.finishedAt,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unsafe Analysis publication", 409);
  }
  if (canonicalHash(snapshot) !== publication.previewHash) {
    return jsonError("Analysis publication changed after preview. Preview it again.", 409);
  }
  try {
    const created = await commitAnalysisPublication({
      organizationId: workspaceId,
      articleId,
      articleRevision: article.liveRevision,
      request: publication,
      snapshot,
      authority: {
        sessionId: authorization.session.session.id,
        userId: authorization.session.user.id,
        membershipId: authorization.membership.id,
        role: authorization.role,
      },
    });
    if (!created) return jsonError("Analysis Article publication authority changed", 409);
    revalidatePath(`/analyses/${created.slug}`);
    revalidatePath(`/api/v1/public/analyses/${created.slug}`);
    return privateJson({ publication: created }, { status: 201 });
  } catch (error) {
    const row = error && typeof error === "object"
      ? error as { code?: unknown; cause?: { code?: unknown } } : null;
    if (row?.code === "23505" || row?.cause?.code === "23505") {
      return jsonError("Analysis Article publication id or slug already exists", 409);
    }
    throw error;
  }
}
