// Immutable Analysis signal history. Editors can inspect every definition and
// lifecycle transition without exposing any observed metric value.
import { and, desc, eq } from "drizzle-orm";

import { db } from "../../../../../../../../../../lib/db";
import { isUuid, jsonError, privateJson } from "../../../../../../../../../../lib/http";
import {
  workspaceAnalysisSignal,
  workspaceAnalysisSignalRevision,
} from "../../../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../../../lib/workspace-authorization";
import { accessibleAnalysisArticle } from "../../../../../../../../../../lib/workspace-analysis-article-http";
import { parseAnalysisSignalVersionPayload } from "../../../../../../../../../../lib/workspace-analysis-signals";
import { hasWorkspaceCapability } from "../../../../../../../../../../lib/workspace-permissions";

type RouteContext = {
  params: Promise<{ workspaceId: string; articleId: string; signalId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, articleId, signalId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(signalId)) {
    return jsonError("Invalid Analysis signal scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Analysis signal history requires workspace Editor access", 403);
  }
  const article = await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: true,
  });
  if (!article) return jsonError("Analysis Article not found", 404);
  const signal = await db.query.workspaceAnalysisSignal.findFirst({
    where: and(
      eq(workspaceAnalysisSignal.organizationId, workspaceId),
      eq(workspaceAnalysisSignal.articleId, articleId),
      eq(workspaceAnalysisSignal.id, signalId),
    ),
    columns: { id: true },
  });
  if (!signal) return jsonError("Analysis signal not found", 404);
  const revisions = await db.select().from(workspaceAnalysisSignalRevision).where(and(
    eq(workspaceAnalysisSignalRevision.organizationId, workspaceId),
    eq(workspaceAnalysisSignalRevision.signalId, signalId),
  )).orderBy(desc(workspaceAnalysisSignalRevision.revision)).limit(200);
  if (revisions.length === 0) return jsonError("Analysis signal not found", 404);
  try {
    const payloads = revisions.map((revision) => parseAnalysisSignalVersionPayload(revision.payload));
    return privateJson({
      articleId,
      signalId,
      revisions: revisions.map((revision, index) => ({
        revision: revision.revision,
        baseRevision: revision.baseRevision,
        operation: revision.operation,
        payload: payloads[index],
        payloadHash: revision.payloadHash,
        createdByMemberId: revision.createdByMemberId,
        createdAt: revision.createdAt.toISOString(),
      })),
    });
  } catch {
    return jsonError("Analysis signal history is invalid", 409);
  }
}
