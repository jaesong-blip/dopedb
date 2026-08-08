import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { isUuid, jsonError, privateJson } from "@/lib/http";
import { githubSourceManifest } from "@/lib/knowledge/github-app";
import { knowledgeGithubInstallation, knowledgeSource } from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string; sourceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, sourceId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(sourceId)) return jsonError("Invalid source id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const [source] = await db.select({
    sourceId: knowledgeSource.id,
    repository: knowledgeSource.repositoryFullName,
    commitSha: knowledgeSource.commitSha,
    environmentRevision: knowledgeSource.environmentRevision,
    syncRevision: knowledgeSource.syncRevision,
    installationId: knowledgeGithubInstallation.installationId,
  }).from(knowledgeSource).innerJoin(
    knowledgeGithubInstallation,
    and(
      eq(knowledgeGithubInstallation.organizationId, knowledgeSource.organizationId),
      eq(knowledgeGithubInstallation.id, knowledgeSource.githubInstallationId),
      eq(knowledgeGithubInstallation.status, "active"),
    ),
  ).where(and(
    eq(knowledgeSource.organizationId, workspaceId),
    eq(knowledgeSource.id, sourceId),
    eq(knowledgeSource.provider, "github"),
    isNull(knowledgeSource.revokedAt),
  )).limit(1);
  if (!source?.repository || !source.commitSha) return jsonError("Knowledge source not found", 404);
  try {
    const files = await githubSourceManifest(
      source.installationId,
      source.repository,
      source.commitSha,
    );
    return privateJson({
      sourceId: source.sourceId,
      environmentRevision: source.environmentRevision,
      syncRevision: source.syncRevision,
      repository: source.repository,
      commitSha: source.commitSha,
      files,
    });
  } catch {
    return jsonError("GitHub source snapshot is unavailable", 424);
  }
}
