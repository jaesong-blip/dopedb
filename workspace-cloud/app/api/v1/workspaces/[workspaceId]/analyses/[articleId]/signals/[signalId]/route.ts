// Optimistic Signal mutation. Re-targeting is explicit and may only select a
// metric block on the currently live Article revision.
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../../../../../../../../lib/db";
import { env } from "../../../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
  privateRevisionMutationJson,
} from "../../../../../../../../../lib/http";
import { workspaceAnalysisSignal } from "../../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../../lib/workspace-authorization";
import { accessibleAnalysisArticle } from "../../../../../../../../../lib/workspace-analysis-article-http";
import {
  commitAnalysisSignalMutation,
  type AnalysisSignalAuthority,
} from "../../../../../../../../../lib/workspace-analysis-signal-store";
import {
  analysisSignalBlockIsEligible,
  parseAnalysisSignalDefinition,
  parseAnalysisSignalMutation,
  type AnalysisSignalCreate,
} from "../../../../../../../../../lib/workspace-analysis-signals";
import { hasWorkspaceCapability } from "../../../../../../../../../lib/workspace-permissions";
import { parseExpectedRevision } from "../../../../../../../../../lib/workspace-versioning";

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

async function expectedRevision(request: Request) {
  try {
    const revision = parseExpectedRevision(request);
    return revision === null
      ? { error: jsonError("Expected revision is required", 428) } as const
      : { value: revision } as const;
  } catch (error) {
    return { error: jsonError(error instanceof Error ? error.message : "Invalid expected revision", 400) } as const;
  }
}

async function currentSignal(workspaceId: string, articleId: string, signalId: string) {
  return db.query.workspaceAnalysisSignal.findFirst({
    where: and(
      eq(workspaceAnalysisSignal.organizationId, workspaceId),
      eq(workspaceAnalysisSignal.articleId, articleId),
      eq(workspaceAnalysisSignal.id, signalId),
      isNull(workspaceAnalysisSignal.deletedAt),
    ),
  });
}

function signalInput(current: typeof workspaceAnalysisSignal.$inferSelect): AnalysisSignalCreate {
  return {
    id: current.id,
    articleRevision: current.articleRevision,
    blockId: current.blockId,
    definition: parseAnalysisSignalDefinition(current.definition),
    enabled: current.enabled,
  };
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, articleId, signalId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(signalId)) {
    return jsonError("Invalid Analysis signal scope", 400);
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
  const signal = await currentSignal(workspaceId, articleId, signalId);
  if (!signal || (!hasWorkspaceCapability(authorization.role, "write")
    && (!signal.enabled || signal.articleRevision !== article.liveRevision))) {
    return jsonError("Analysis signal not found", 404);
  }
  return privateJson({ signal });
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, articleId, signalId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(signalId)) {
    return jsonError("Invalid Analysis signal scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "write");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Analysis signal editing requires workspace Editor access", 403);
  }
  const match = await expectedRevision(request);
  if ("error" in match) return match.error;
  const current = await currentSignal(workspaceId, articleId, signalId);
  if (!current) return jsonError("Analysis signal not found", 404);
  if (current.revision !== match.value) {
    return jsonError("Analysis signal changed concurrently. Refresh before continuing.", 409);
  }
  const body = await boundedJsonBody(request, 64 * 1024);
  if (!body.ok) return jsonError("Invalid Analysis signal action", 400);
  let mutation;
  let existing;
  try {
    mutation = parseAnalysisSignalMutation(body.value);
    existing = signalInput(current);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid Analysis signal action", 400);
  }
  if (mutation.action === "delete") {
    return jsonError("Use DELETE to remove an Analysis signal", 405);
  }
  const next: AnalysisSignalCreate = mutation.action === "update"
    ? {
      ...existing,
      articleRevision: mutation.articleRevision,
      blockId: mutation.blockId,
      definition: mutation.definition,
    }
    : { ...existing, enabled: mutation.action === "enable" };
  const article = await accessibleAnalysisArticle({
    organizationId: workspaceId,
    articleId,
    memberId: authorization.membership.id,
    includeWorking: false,
  });
  if (!article || article.liveRevision !== next.articleRevision
    || !analysisSignalBlockIsEligible(article.definition, next.blockId)) {
    return jsonError("Analysis signals require an unmasked numeric metric on the current live revision", 409);
  }
  const updated = await commitAnalysisSignalMutation({
    organizationId: workspaceId,
    articleId,
    signal: next,
    expectedRevision: match.value,
    operation: mutation.action,
    authority: authority(authorization),
  });
  if (!updated) return jsonError("Analysis signal authority changed", 409);
  return privateRevisionMutationJson(request, { signal: updated });
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, articleId, signalId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(signalId)) {
    return jsonError("Invalid Analysis signal scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "write");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Analysis signal deletion requires workspace Editor access", 403);
  }
  const match = await expectedRevision(request);
  if ("error" in match) return match.error;
  const current = await currentSignal(workspaceId, articleId, signalId);
  if (!current) return jsonError("Analysis signal not found", 404);
  if (current.revision !== match.value) {
    return jsonError("Analysis signal changed concurrently. Refresh before deleting.", 409);
  }
  let existing;
  try {
    existing = signalInput(current);
  } catch {
    return jsonError("Analysis signal definition is invalid", 409);
  }
  const deleted = await commitAnalysisSignalMutation({
    organizationId: workspaceId,
    articleId,
    signal: { ...existing, enabled: false },
    expectedRevision: match.value,
    operation: "delete",
    authority: authority(authorization),
  });
  if (!deleted) return jsonError("Analysis signal authority changed", 409);
  return privateRevisionMutationJson(request, {
    deleted: true,
    revision: Number(deleted.revision),
  });
}
