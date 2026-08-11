// Produces the exact safe immutable snapshot that a later publication request
// must hash-bind. Preview has no side effect and exposes no SQL or connection id.
import { and, eq, gt } from "drizzle-orm";

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
  workspaceAnalysisArticleRun,
  workspaceAnalysisResultFragment,
} from "../../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../../lib/workspace-authorization";
import { accessibleAnalysisArticle } from "../../../../../../../../../lib/workspace-analysis-article-http";
import {
  buildAnalysisPublicSnapshot,
  parseAnalysisPublicationRequest,
} from "../../../../../../../../../lib/workspace-analysis-publications";
import { openAnalysisResultFragments } from "../../../../../../../../../lib/workspace-analysis-results";
import { hasWorkspaceCapability } from "../../../../../../../../../lib/workspace-permissions";
import { canonicalHash } from "../../../../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ workspaceId: string; articleId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, articleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId)) {
    return jsonError("Invalid Analysis Article publication scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "write");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Analysis Article publication preview requires Editor access", 403);
  }
  const body = await boundedJsonBody(request, 16 * 1024);
  if (!body.ok) return jsonError("Invalid Analysis Article publication preview", 400);
  let publication;
  try {
    publication = parseAnalysisPublicationRequest(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid publication preview", 400);
  }
  if (publication.previewHash !== null) {
    return jsonError("A preview request cannot assert its own snapshot hash", 400);
  }
  const article = await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: false,
  });
  if (!article || !article.liveRevision || article.liveRunId !== publication.runId) {
    return jsonError("Only the current live Analysis Article result can be previewed", 409);
  }
  if (article.ownerMemberId !== authorization.membership.id
    && authorization.role !== "admin" && authorization.role !== "owner") {
    return jsonError("Only the Article owner or a workspace administrator can publish it", 403);
  }
  const run = await db.query.workspaceAnalysisArticleRun.findFirst({
    where: and(
      eq(workspaceAnalysisArticleRun.organizationId, workspaceId),
      eq(workspaceAnalysisArticleRun.articleId, articleId),
      eq(workspaceAnalysisArticleRun.id, publication.runId),
      eq(workspaceAnalysisArticleRun.state, "succeeded"),
    ),
  });
  if (!run?.finishedAt) return jsonError("Live Analysis Article result is unavailable", 409);
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
    const snapshot = buildAnalysisPublicSnapshot({
      request: publication,
      definition: article.definition,
      parameterValues: run.parameterValues as Record<string, string | number | boolean | null>,
      fragments,
      dataAsOf: run.finishedAt,
    });
    return privateJson({ snapshot, snapshotHash: canonicalHash(snapshot) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Publication preview unavailable", 409);
  }
}
