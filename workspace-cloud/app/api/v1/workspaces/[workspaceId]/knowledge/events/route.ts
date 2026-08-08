import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { isUuid, jsonError, privateJson } from "@/lib/http";
import { knowledgeSource, knowledgeSourceEvent } from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const url = new URL(request.url);
  const sourceId = url.searchParams.get("sourceId");
  if (
    !isUuid(workspaceId)
    || !sourceId
    || !isUuid(sourceId)
  ) return jsonError("Invalid Knowledge event cursor", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const rows = await db.select({
    id: knowledgeSourceEvent.id,
    eventKind: knowledgeSourceEvent.eventKind,
    beforeCommitSha: knowledgeSourceEvent.beforeCommitSha,
    afterCommitSha: knowledgeSourceEvent.afterCommitSha,
    changedFiles: knowledgeSourceEvent.changedFiles,
    createdAt: knowledgeSourceEvent.createdAt,
  }).from(knowledgeSourceEvent).innerJoin(
    knowledgeSource,
    and(
      eq(knowledgeSource.organizationId, knowledgeSourceEvent.organizationId),
      eq(knowledgeSource.id, knowledgeSourceEvent.sourceId),
      isNull(knowledgeSource.revokedAt),
    ),
  ).where(and(
    eq(knowledgeSourceEvent.organizationId, workspaceId),
    eq(knowledgeSourceEvent.sourceId, sourceId),
    eq(knowledgeSourceEvent.state, "pending"),
  )).orderBy(asc(knowledgeSourceEvent.createdAt), asc(knowledgeSourceEvent.id)).limit(100);
  return privateJson({ events: rows });
}
