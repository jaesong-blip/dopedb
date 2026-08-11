import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import {
  boundedJsonBody,
  isSafeDisplayText,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "@/lib/http";
import {
  listGithubRepositories,
  resolveGithubCommit,
} from "@/lib/knowledge/github-app";
import { enqueueInitialGithubKnowledgeSync } from "@/lib/knowledge/sync-queue";
import {
  knowledgeGithubInstallation,
  knowledgeEnvironmentHead,
  knowledgeProjectEnvironment,
  knowledgeSource,
} from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const sources = await db.select({
    id: knowledgeSource.id,
    projectId: knowledgeSource.projectId,
    projectEnvironmentId: knowledgeSource.projectEnvironmentId,
    environmentRevision: knowledgeSource.environmentRevision,
    provider: knowledgeSource.provider,
    displayName: knowledgeSource.displayName,
    visibility: knowledgeSource.visibility,
    repositoryId: knowledgeSource.repositoryId,
    repositoryFullName: knowledgeSource.repositoryFullName,
    refName: knowledgeSource.refName,
    commitSha: knowledgeSource.commitSha,
    syncState: knowledgeSource.syncState,
    syncRevision: knowledgeSource.syncRevision,
    lastFailureCode: knowledgeSource.lastFailureCode,
    graphRevisionId: knowledgeEnvironmentHead.graphRevisionId,
  }).from(knowledgeSource).leftJoin(knowledgeEnvironmentHead, and(
    eq(knowledgeEnvironmentHead.organizationId, knowledgeSource.organizationId),
    eq(knowledgeEnvironmentHead.projectEnvironmentId, knowledgeSource.projectEnvironmentId),
    eq(knowledgeEnvironmentHead.sourceId, knowledgeSource.id),
  )).where(and(
    eq(knowledgeSource.organizationId, workspaceId),
    isNull(knowledgeSource.revokedAt),
  ));
  return privateJson({ sources });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const parsed = await boundedJsonBody(request, 16 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (
    !body
    || body.provider !== "github"
    || typeof body.sourceId !== "string"
    || !isUuid(body.sourceId)
    || typeof body.projectId !== "string"
    || !isUuid(body.projectId)
    || typeof body.projectEnvironmentId !== "string"
    || !isUuid(body.projectEnvironmentId)
    || typeof body.displayName !== "string"
    || !isSafeDisplayText(body.displayName.trim(), 512)
  ) {
    return jsonError("Invalid Knowledge source", 400);
  }
  const [environment] = await db.select({
    id: knowledgeProjectEnvironment.id,
    projectId: knowledgeProjectEnvironment.projectId,
    revision: knowledgeProjectEnvironment.revision,
  }).from(knowledgeProjectEnvironment).where(and(
    eq(knowledgeProjectEnvironment.organizationId, workspaceId),
    eq(knowledgeProjectEnvironment.id, body.projectEnvironmentId),
    eq(knowledgeProjectEnvironment.projectId, body.projectId),
  )).limit(1);
  if (!environment) {
    return jsonError("Project Environment was not found", 404);
  }
  if (
    typeof body.installationId !== "string"
    || !isUuid(body.installationId)
    || typeof body.repositoryId !== "string"
    || !/^[1-9][0-9]{0,19}$/.test(body.repositoryId)
    || typeof body.repositoryFullName !== "string"
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.repositoryFullName)
    || typeof body.refName !== "string"
    || !/^[A-Za-z0-9._\/-]{1,255}$/.test(body.refName)
    || body.refName.includes("..")
    || body.refName.includes("//")
  ) {
    return jsonError("Invalid GitHub Knowledge source", 400);
  }
  const [installation] = await db.select({
    id: knowledgeGithubInstallation.id,
    installationId: knowledgeGithubInstallation.installationId,
  }).from(knowledgeGithubInstallation).where(and(
    eq(knowledgeGithubInstallation.organizationId, workspaceId),
    eq(knowledgeGithubInstallation.id, body.installationId),
    eq(knowledgeGithubInstallation.status, "active"),
  )).limit(1);
  if (!installation) {
    return jsonError("GitHub installation was not found", 404);
  }
  try {
    const repositories = await listGithubRepositories(installation.installationId);
    const repository = repositories.find((candidate) =>
      String(candidate.id) === body.repositoryId
      && candidate.full_name === body.repositoryFullName
    );
    if (!repository || repository.archived) {
      return jsonError("GitHub repository is not available to this installation", 403);
    }
    const commitSha = await resolveGithubCommit(
      installation.installationId,
      repository.full_name,
      body.refName,
    );
    const [inserted] = await db.insert(knowledgeSource).values({
      id: body.sourceId,
      organizationId: workspaceId,
      projectId: body.projectId,
      projectEnvironmentId: body.projectEnvironmentId,
      environmentRevision: environment.revision,
      provider: "github",
      displayName: body.displayName.trim(),
      visibility: "shared_graph",
      githubInstallationId: installation.id,
      repositoryId: body.repositoryId,
      repositoryFullName: repository.full_name,
      refName: body.refName,
      commitSha,
      syncState: "pending",
    }).onConflictDoNothing().returning({
      id: knowledgeSource.id,
      syncRevision: knowledgeSource.syncRevision,
      environmentRevision: knowledgeSource.environmentRevision,
      commitSha: knowledgeSource.commitSha,
    });
    const [source] = inserted ? [inserted] : await db.select({
      id: knowledgeSource.id,
      syncRevision: knowledgeSource.syncRevision,
      environmentRevision: knowledgeSource.environmentRevision,
      commitSha: knowledgeSource.commitSha,
      projectId: knowledgeSource.projectId,
      projectEnvironmentId: knowledgeSource.projectEnvironmentId,
      provider: knowledgeSource.provider,
      githubInstallationId: knowledgeSource.githubInstallationId,
      repositoryId: knowledgeSource.repositoryId,
      repositoryFullName: knowledgeSource.repositoryFullName,
      refName: knowledgeSource.refName,
    }).from(knowledgeSource).where(and(
      eq(knowledgeSource.organizationId, workspaceId),
      eq(knowledgeSource.id, body.sourceId),
    )).limit(1);
    if (
      !source
      || ("provider" in source && (
        source.projectId !== body.projectId
        || source.projectEnvironmentId !== body.projectEnvironmentId
        || source.provider !== "github"
        || source.githubInstallationId !== installation.id
        || source.repositoryId !== body.repositoryId
        || source.repositoryFullName !== repository.full_name
        || source.refName !== body.refName
      ))
    ) return jsonError("Knowledge source id is already bound", 409);
    await enqueueInitialGithubKnowledgeSync({
      organizationId: workspaceId,
      sourceId: body.sourceId,
      commitSha,
    });
    return privateJson({ source }, { status: 201 });
  } catch {
    return jsonError("GitHub source verification failed", 424);
  }
}
