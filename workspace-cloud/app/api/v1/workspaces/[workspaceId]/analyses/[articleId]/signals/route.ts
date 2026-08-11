// Shared signals are attached only to a metric block of the current live
// Article revision. Editors see disabled definitions; viewers see only active
// signals for the revision they can read.
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "../../../../../../../../lib/db";
import { env } from "../../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../lib/http";
import { workspaceAnalysisSignal } from "../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";
import { accessibleAnalysisArticle } from "../../../../../../../../lib/workspace-analysis-article-http";
import {
  commitAnalysisSignalCreate,
  type AnalysisSignalAuthority,
} from "../../../../../../../../lib/workspace-analysis-signal-store";
import {
  analysisSignalBlockIsEligible,
  parseAnalysisSignalCreate,
} from "../../../../../../../../lib/workspace-analysis-signals";
import { hasWorkspaceCapability } from "../../../../../../../../lib/workspace-permissions";

type RouteContext = { params: Promise<{ workspaceId: string; articleId: string }> };

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

function publicSignal(row: typeof workspaceAnalysisSignal.$inferSelect) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, articleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId)) {
    return jsonError("Invalid Analysis Article signal scope", 400);
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
  const filters = [
    eq(workspaceAnalysisSignal.organizationId, workspaceId),
    eq(workspaceAnalysisSignal.articleId, articleId),
    isNull(workspaceAnalysisSignal.deletedAt),
  ];
  if (!canEdit) {
    filters.push(eq(workspaceAnalysisSignal.enabled, true));
    if (!article.liveRevision) return privateJson({ signals: [] });
    filters.push(eq(workspaceAnalysisSignal.articleRevision, article.liveRevision));
  }
  const signals = await db.select().from(workspaceAnalysisSignal)
    .where(and(...filters))
    .orderBy(desc(workspaceAnalysisSignal.updatedAt));
  return privateJson({ signals: signals.map(publicSignal) });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, articleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId)) {
    return jsonError("Invalid Analysis Article signal scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "write");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Analysis signal creation requires workspace Editor access", 403);
  }
  const body = await boundedJsonBody(request, 64 * 1024);
  if (!body.ok) return jsonError("Invalid Analysis signal", 400);
  let signal;
  try {
    signal = parseAnalysisSignalCreate(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid Analysis signal", 400);
  }
  const article = await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: false,
  });
  if (!article || article.liveRevision !== signal.articleRevision) {
    return jsonError("Signals can only target the current live Analysis Article revision", 409);
  }
  if (!analysisSignalBlockIsEligible(article.definition, signal.blockId)) {
    return jsonError("Analysis signals require an unmasked public or internal numeric metric", 409);
  }
  try {
    const created = await commitAnalysisSignalCreate({
      organizationId: workspaceId,
      articleId,
      signal,
      authority: authority(authorization),
    });
    if (!created) return jsonError("Analysis signal authority changed", 409);
    return privateJson({ signal: created }, { status: 201 });
  } catch (error) {
    const row = error && typeof error === "object"
      ? error as { code?: unknown; cause?: { code?: unknown } } : null;
    if (row?.code === "23505" || row?.cause?.code === "23505") {
      return jsonError("Analysis signal already exists", 409);
    }
    throw error;
  }
}
