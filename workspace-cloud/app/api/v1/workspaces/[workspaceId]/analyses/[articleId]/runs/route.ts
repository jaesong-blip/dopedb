// List and start exact-revision Analysis Article runs on a member-owned Desktop runner.
import { and, desc, eq, lt } from "drizzle-orm";

import { db } from "../../../../../../../../lib/db";
import { env } from "../../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../lib/http";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";
import { workspaceAnalysisArticleRun } from "../../../../../../../../lib/schema";
import { accessibleAnalysisArticle } from "../../../../../../../../lib/workspace-analysis-article-http";
import {
  analysisRunnerCapabilityHeader,
  hashAnalysisRunnerCapability,
  isAnalysisDesktopBearerRequest,
  parseAnalysisRunnerCapability,
} from "../../../../../../../../lib/workspace-analysis-runner-capability";
import { hashAnalysisLeaseCapability } from "../../../../../../../../lib/workspace-analysis-runner-store";
import {
  commitAnalysisRunCreate,
  type AnalysisRunAuthority,
} from "../../../../../../../../lib/workspace-analysis-run-store";
import { parseAnalysisRunRequest } from "../../../../../../../../lib/workspace-analysis-runs";
import { hasWorkspaceCapability } from "../../../../../../../../lib/workspace-permissions";
import { canonicalHash } from "../../../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ workspaceId: string; articleId: string }> };

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

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, articleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId)) {
    return jsonError("Invalid workspace or Analysis Article id", 400);
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
  const url = new URL(request.url);
  const beforeValue = url.searchParams.get("before");
  const before = beforeValue ? new Date(beforeValue) : null;
  if (before && Number.isNaN(before.valueOf())) return jsonError("Invalid run cursor", 400);
  const filters = [
    eq(workspaceAnalysisArticleRun.organizationId, workspaceId),
    eq(workspaceAnalysisArticleRun.articleId, articleId),
  ];
  if (before) filters.push(lt(workspaceAnalysisArticleRun.createdAt, before));
  const rows = await db.select().from(workspaceAnalysisArticleRun)
    .where(and(...filters))
    .orderBy(desc(workspaceAnalysisArticleRun.createdAt))
    .limit(100);
  const visible = canEdit ? rows : rows.filter((run) => run.id === article.liveRunId);
  return privateJson({
    runs: visible.map((run) => ({
      ...run,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
    })),
    nextCursor: rows.length === 100 ? rows.at(-1)!.createdAt.toISOString() : null,
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  if (!isAnalysisDesktopBearerRequest(request)) {
    return jsonError("Analysis run execution requires a Desktop bearer session", 401);
  }
  const { workspaceId, articleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId)) {
    return jsonError("Invalid workspace or Analysis Article id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const runnerCapability = parseAnalysisRunnerCapability(request);
  if (!runnerCapability) return jsonError(
    "Invalid Analysis runner capability",
    request.headers.has(analysisRunnerCapabilityHeader) ? 403 : 428,
  );
  const body = await boundedJsonBody(request, 128 * 1024);
  if (!body.ok || !body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return jsonError("Invalid Analysis Article run request", 400);
  }
  const requestedRevision = (body.value as Record<string, unknown>).articleRevision;
  if (typeof requestedRevision !== "number" || !Number.isSafeInteger(requestedRevision)) {
    return jsonError("Invalid Analysis Article revision", 400);
  }
  const canEdit = hasWorkspaceCapability(authorization.role, "write");
  const working = canEdit ? await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: true,
  }) : null;
  const article = working?.revision === requestedRevision
    ? working
    : await accessibleAnalysisArticle({
      organizationId: workspaceId,
      articleId,
      memberId: authorization.membership.id,
      includeWorking: false,
    });
  if (!article || article.revision !== requestedRevision) {
    return jsonError("Analysis Article revision is not runnable", 404);
  }
  let run;
  try {
    run = parseAnalysisRunRequest(body.value, article.definition);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid Analysis Article run", 400);
  }
  const leaseId = request.headers.get("x-dopedb-analysis-lease")?.trim() ?? null;
  const leaseCapability = request.headers.get("x-dopedb-analysis-capability")?.trim() ?? null;
  if (run.trigger === "schedule") {
    if (!leaseId || !isUuid(leaseId) || !leaseCapability || !/^[0-9a-f]{64}$/.test(leaseCapability)) {
      return jsonError("A scheduled run requires its refresh lease capability", 403);
    }
  } else if (run.trigger === "signal") {
    return jsonError("Signal evaluation starts from an Article signal, not the manual run API", 409);
  } else if (leaseId !== null || leaseCapability !== null) {
    return jsonError("Manual runs cannot carry a refresh lease", 400);
  }
  const created = await commitAnalysisRunCreate({
    organizationId: workspaceId,
    articleId,
    run,
    parameterHash: canonicalHash(run.parameterValues),
    definitionHash: canonicalHash(article.definition),
    runnerCapabilityHash: hashAnalysisRunnerCapability(runnerCapability),
    leaseId: run.trigger === "schedule" ? leaseId : null,
    leaseCapabilityHash: run.trigger === "schedule" && leaseCapability
      ? hashAnalysisLeaseCapability(leaseCapability)
      : null,
    authority: authority(authorization),
  });
  if (!created) {
    return jsonError("Analysis run authority changed. Refresh the Article, grants, and runner.", 409);
  }
  return privateJson({ run: created, article }, { status: 201 });
}
