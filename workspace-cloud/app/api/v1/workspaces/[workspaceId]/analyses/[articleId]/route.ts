// One Analysis Article's optimistic lifecycle. A published liveRevision remains
// visible while editors revise the working projection; a new live revision is
// accepted only after the exact working revision has a successful Desktop run.
import { and, eq } from "drizzle-orm";

import { db } from "../../../../../../../lib/db";
import { env } from "../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../lib/http";
import {
  workspaceAnalysisArticleRevision,
  workspaceAnalysisArticleRun,
} from "../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";
import { accessibleAnalysisArticle } from "../../../../../../../lib/workspace-analysis-article-http";
import {
  commitAnalysisArticleMutation,
  type AnalysisArticleMutationAuthority,
  type AnalysisArticleMutationOperation,
} from "../../../../../../../lib/workspace-analysis-article-store";
import {
  parseAnalysisArticleVersionPayload,
  parseSharedAnalysisArticleCreate,
  publicAnalysisArticle,
  type AnalysisArticleState,
  type SharedAnalysisArticleCreate,
} from "../../../../../../../lib/workspace-analysis-articles";
import { hasWorkspaceCapability } from "../../../../../../../lib/workspace-permissions";
import { parseExpectedRevision } from "../../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ workspaceId: string; articleId: string }> };

function authority(authorization: {
  role: string;
  session: { session: { id: string }; user: { id: string } };
  membership: { id: string };
}): AnalysisArticleMutationAuthority {
  return {
    sessionId: authorization.session.session.id,
    userId: authorization.session.user.id,
    membershipId: authorization.membership.id,
    role: authorization.role,
  };
}

function articleInput(article: {
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  sourceKnowledgeGrantId: string | null;
  graphRevisionIds: readonly string[];
  connections: readonly unknown[];
  definition: unknown;
}) {
  return parseSharedAnalysisArticleCreate({
    id: article.id,
    projectEnvironmentId: article.projectEnvironmentId,
    environmentRevision: article.environmentRevision,
    sourceKnowledgeGrantId: article.sourceKnowledgeGrantId,
    graphRevisionIds: article.graphRevisionIds,
    connections: article.connections,
    definition: article.definition,
  });
}

async function expectedRevision(request: Request) {
  try {
    const value = parseExpectedRevision(request);
    if (value === null) return { error: jsonError("If-Match is required", 428) } as const;
    return { value } as const;
  } catch (error) {
    return {
      error: jsonError(error instanceof Error ? error.message : "Invalid If-Match", 400),
    } as const;
  }
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, articleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId)) {
    return jsonError("Invalid workspace or Analysis Article id", 400);
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
  return privateJson({ article });
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, articleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId)) {
    return jsonError("Invalid workspace or Analysis Article id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "write");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Analysis Article editing requires workspace Editor access", 403);
  }
  const match = await expectedRevision(request);
  if ("error" in match) return match.error;
  const current = await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: true,
  });
  if (!current) return jsonError("Analysis Article not found", 404);
  if (match.value !== current.revision) {
    return jsonError("Analysis Article changed concurrently. Refresh before continuing.", 409);
  }
  const parsed = await boundedJsonBody(request, 1024 * 1024);
  const body = parsed.ok && parsed.value && typeof parsed.value === "object"
    && !Array.isArray(parsed.value)
    ? parsed.value as Record<string, unknown>
    : null;
  if (!body || typeof body.action !== "string") {
    return jsonError("Invalid Analysis Article action", 400);
  }

  let nextArticle: SharedAnalysisArticleCreate = articleInput(current);
  let nextState = current.state as AnalysisArticleState;
  let ownerMemberId = current.ownerMemberId;
  let operation: AnalysisArticleMutationOperation;

  if (body.action === "update" && Object.keys(body).length === 2) {
    try {
      nextArticle = parseSharedAnalysisArticleCreate(body.article);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Invalid Analysis Article", 400);
    }
    if (nextArticle.id !== articleId) return jsonError("Analysis Article identity cannot change", 409);
    nextState = "draft";
    operation = nextArticle.definition.source === "human" ? "update" : "propose";
  } else if (body.action === "submitReview" && Object.keys(body).length === 1) {
    if (current.state !== "draft") return jsonError("Only a draft can enter review", 409);
    nextState = "review";
    operation = "submit_review";
  } else if (body.action === "returnDraft" && Object.keys(body).length === 1) {
    if (current.state !== "review") return jsonError("Only a review can return to draft", 409);
    nextState = "draft";
    operation = "return_draft";
  } else if (body.action === "publishLive" && Object.keys(body).length === 1) {
    if (current.state !== "review") return jsonError("Approve the review before publishing live", 409);
    if (!current.latestSuccessfulRunId) {
      return jsonError("Run this exact review successfully before publishing it live", 409);
    }
    const successfulRun = await db.query.workspaceAnalysisArticleRun.findFirst({
      where: and(
        eq(workspaceAnalysisArticleRun.organizationId, workspaceId),
        eq(workspaceAnalysisArticleRun.articleId, articleId),
        eq(workspaceAnalysisArticleRun.id, current.latestSuccessfulRunId),
        eq(workspaceAnalysisArticleRun.articleRevision, current.revision),
        eq(workspaceAnalysisArticleRun.state, "succeeded"),
      ),
      columns: { id: true },
    });
    if (!successfulRun) {
      return jsonError("Run this exact review successfully before publishing it live", 409);
    }
    nextState = "live";
    operation = "publish_live";
  } else if (body.action === "archive" && Object.keys(body).length === 1) {
    nextState = "archived";
    operation = "archive";
  } else if (
    body.action === "transfer"
    && Object.keys(body).length === 2
    && typeof body.ownerMemberId === "string"
    && isUuid(body.ownerMemberId)
  ) {
    ownerMemberId = body.ownerMemberId;
    operation = "transfer";
  } else if (
    body.action === "restore"
    && Object.keys(body).length === 2
    && typeof body.revision === "number"
    && Number.isSafeInteger(body.revision)
    && body.revision >= 1
  ) {
    const historical = await db.query.workspaceAnalysisArticleRevision.findFirst({
      where: and(
        eq(workspaceAnalysisArticleRevision.organizationId, workspaceId),
        eq(workspaceAnalysisArticleRevision.articleId, articleId),
        eq(workspaceAnalysisArticleRevision.revision, body.revision),
      ),
      columns: { payload: true },
    });
    if (!historical) return jsonError("Analysis Article revision not found", 404);
    try {
      const payload = parseAnalysisArticleVersionPayload(historical.payload);
      if (payload.deleted || payload.id !== articleId) {
        return jsonError("Analysis Article revision cannot be restored", 409);
      }
      nextArticle = payload;
      ownerMemberId = payload.ownerMemberId;
      nextState = "draft";
    } catch {
      return jsonError("Analysis Article revision is invalid", 409);
    }
    operation = "restore";
  } else {
    return jsonError("Invalid Analysis Article action", 400);
  }

  const updated = await commitAnalysisArticleMutation({
    organizationId: workspaceId,
    article: nextArticle,
    expectedRevision: current.revision,
    state: nextState,
    ownerMemberId,
    authority: authority(authorization),
    operation,
  });
  if (!updated) {
    return jsonError(
      "Analysis authority changed. Refresh the Environment, connection grants, mappings, Knowledge grant, and runner.",
      409,
    );
  }
  return privateJson({
    article: publicAnalysisArticle({
      ...updated,
      graphRevisionIds: nextArticle.graphRevisionIds,
      connections: nextArticle.connections,
    }),
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, articleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId)) {
    return jsonError("Invalid workspace or Analysis Article id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "write");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const match = await expectedRevision(request);
  if ("error" in match) return match.error;
  const current = await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: true,
    includeDeleted: true,
  });
  if (!current) return jsonError("Analysis Article not found", 404);
  if (match.value !== current.revision) {
    return jsonError("Analysis Article changed concurrently. Refresh before deleting.", 409);
  }
  const deleted = await commitAnalysisArticleMutation({
    organizationId: workspaceId,
    article: articleInput(current),
    expectedRevision: current.revision,
    state: "archived",
    ownerMemberId: current.ownerMemberId,
    authority: authority(authorization),
    operation: "delete",
  });
  if (!deleted) return jsonError("Analysis Article authority changed. Retry deletion.", 409);
  return privateJson({ deleted: true, revision: deleted.revision });
}
