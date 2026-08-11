import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { isUuid, jsonError, privateJson } from "@/lib/http";
import { authorizeKnowledgeGrant } from "@/lib/knowledge/authorization";
import {
  knowledgeGraphRevision,
} from "@/lib/schema";

type RouteContext = { params: Promise<{ workspaceId: string; sourceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, sourceId } = await context.params;
  const grantId = new URL(request.url).searchParams.get("grantId");
  if (!isUuid(workspaceId) || !isUuid(sourceId) || !grantId || !isUuid(grantId)) {
    return jsonError("Invalid Knowledge graph request", 400);
  }
  const authorization = await authorizeKnowledgeGrant(request, workspaceId, grantId);
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const authorizedRevision = authorization.revisions.find(
    (revision) => revision.sourceId === sourceId,
  );
  if (!authorizedRevision) return jsonError("Knowledge source is outside this grant", 403);
  const [revision] = await db.select({
    sourceId: knowledgeGraphRevision.sourceId,
    artifact: knowledgeGraphRevision.artifact,
    artifactSha256: knowledgeGraphRevision.artifactSha256,
  }).from(knowledgeGraphRevision).where(and(
    eq(knowledgeGraphRevision.organizationId, workspaceId),
    eq(knowledgeGraphRevision.id, authorizedRevision.graphRevisionId),
    eq(knowledgeGraphRevision.sourceId, sourceId),
    eq(knowledgeGraphRevision.projectEnvironmentId, authorization.grant.projectEnvironmentId),
    eq(knowledgeGraphRevision.environmentRevision, authorization.grant.environmentRevision),
  )).limit(1);
  if (!revision) return jsonError("Knowledge graph revision not found", 404);
  return privateJson({
    graphRevisionId: authorizedRevision.graphRevisionId,
    artifactSha256: revision.artifactSha256,
    artifact: revision.artifact,
  });
}
