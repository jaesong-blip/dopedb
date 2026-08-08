import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { boundedJsonBody, isUuid, jsonError, mutationAllowed, privateJson } from "@/lib/http";
import { validateGraphBuildArtifact } from "@/lib/knowledge/artifact";
import { authorizeKnowledgeGrant } from "@/lib/knowledge/authorization";
import {
  knowledgeEnvironmentHead,
  knowledgeGraphRevision,
  knowledgeMappingProposal,
  knowledgeProjectEnvironment,
  knowledgeSource,
  knowledgeSourceEvent,
} from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string; sourceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, sourceId } = await context.params;
  const grantId = new URL(request.url).searchParams.get("grantId");
  if (!isUuid(workspaceId) || !isUuid(sourceId) || !grantId || !isUuid(grantId)) {
    return jsonError("Invalid Knowledge graph request", 400);
  }
  const authorization = await authorizeKnowledgeGrant(request, workspaceId, grantId);
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const [revision] = await db.select({
    sourceId: knowledgeGraphRevision.sourceId,
    artifact: knowledgeGraphRevision.artifact,
    artifactSha256: knowledgeGraphRevision.artifactSha256,
  }).from(knowledgeGraphRevision).where(and(
    eq(knowledgeGraphRevision.organizationId, workspaceId),
    eq(knowledgeGraphRevision.id, authorization.grant.graphRevisionId),
    eq(knowledgeGraphRevision.sourceId, sourceId),
    eq(knowledgeGraphRevision.projectEnvironmentId, authorization.grant.projectEnvironmentId),
    eq(knowledgeGraphRevision.environmentRevision, authorization.grant.environmentRevision),
  )).limit(1);
  if (!revision) return jsonError("Knowledge graph revision not found", 404);
  return privateJson({
    graphRevisionId: authorization.grant.graphRevisionId,
    artifactSha256: revision.artifactSha256,
    artifact: revision.artifact,
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, sourceId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(sourceId)) return jsonError("Invalid source id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const parsed = await boundedJsonBody(request, 256 * 1024 * 1024);
  const wrapper = parsed.ok && parsed.value && typeof parsed.value === "object"
    && !Array.isArray(parsed.value)
    ? parsed.value as Record<string, unknown>
    : null;
  const approval = wrapper?.approval && typeof wrapper.approval === "object"
    && !Array.isArray(wrapper.approval)
    ? wrapper.approval as Record<string, unknown>
    : null;
  const validated = validateGraphBuildArtifact(wrapper?.artifact);
  if (
    !wrapper
    || Object.keys(wrapper).length !== 2
    || !approval
    || Object.keys(approval).sort().join(",") !== "artifactSha256,exposure,sourceId"
    || approval.sourceId !== sourceId
    || approval.exposure !== "normalized_graph_only"
    || typeof approval.artifactSha256 !== "string"
    || !validated
    || approval.artifactSha256 !== validated.artifactSha256
  ) {
    return jsonError("Invalid or unapproved Knowledge graph artifact", 400);
  }
  const { artifact, artifactSha256 } = validated;
  const [source] = await db.select({
    id: knowledgeSource.id,
    projectId: knowledgeSource.projectId,
    projectEnvironmentId: knowledgeSource.projectEnvironmentId,
    environmentRevision: knowledgeSource.environmentRevision,
    provider: knowledgeSource.provider,
    repositoryId: knowledgeSource.repositoryId,
    repositoryFullName: knowledgeSource.repositoryFullName,
    refName: knowledgeSource.refName,
    commitSha: knowledgeSource.commitSha,
    rootFingerprint: knowledgeSource.rootFingerprint,
    snapshotSha256: knowledgeSource.snapshotSha256,
  }).from(knowledgeSource).where(and(
    eq(knowledgeSource.organizationId, workspaceId),
    eq(knowledgeSource.id, sourceId),
    isNull(knowledgeSource.revokedAt),
  )).limit(1);
  if (!source) return jsonError("Knowledge source not found", 404);
  const revision = artifact.binding.revision;
  const providerMatches = source.provider === artifact.binding.provider
    && source.id === artifact.binding.sourceId
    && source.projectId === artifact.binding.projectId
    && source.projectEnvironmentId === artifact.binding.projectEnvironmentId
    && source.environmentRevision === artifact.environmentRevision
    && (
      source.provider === "github"
        ? revision.kind === "github"
          && revision.repository_id === source.repositoryId
          && revision.repository === source.repositoryFullName
          && revision.ref_name === source.refName
          && revision.commit_sha === source.commitSha
        : (revision.kind === "local_git" || revision.kind === "local_snapshot")
          && revision.root_fingerprint === source.rootFingerprint
          && artifact.sourceRevisionSha256 === source.snapshotSha256
    );
  if (!providerMatches) return jsonError("Knowledge artifact crossed source identity", 409);

  try {
    await db.transaction(async (transaction) => {
      const locked = await transaction.update(knowledgeProjectEnvironment).set({
        updatedAt: sql`${knowledgeProjectEnvironment.updatedAt}`,
      }).where(and(
        eq(knowledgeProjectEnvironment.organizationId, workspaceId),
        eq(knowledgeProjectEnvironment.id, source.projectEnvironmentId),
        eq(knowledgeProjectEnvironment.projectId, source.projectId),
        eq(knowledgeProjectEnvironment.revision, source.environmentRevision),
      )).returning({ id: knowledgeProjectEnvironment.id });
      if (locked.length !== 1) throw new Error("stale_environment");
      const [head] = await transaction.select({
        graphRevisionId: knowledgeEnvironmentHead.graphRevisionId,
      }).from(knowledgeEnvironmentHead).where(and(
        eq(knowledgeEnvironmentHead.organizationId, workspaceId),
        eq(knowledgeEnvironmentHead.projectEnvironmentId, source.projectEnvironmentId),
      )).limit(1);
      if ((head?.graphRevisionId ?? null) !== artifact.parentGraphRevisionId) {
        throw new Error("stale_parent");
      }
      await transaction.insert(knowledgeGraphRevision).values({
        id: artifact.graphRevisionId,
        organizationId: workspaceId,
        sourceId,
        projectEnvironmentId: source.projectEnvironmentId,
        environmentRevision: artifact.environmentRevision,
        parentGraphRevisionId: artifact.parentGraphRevisionId,
        sourceRevisionSha256: artifact.sourceRevisionSha256,
        artifactSha256,
        artifact,
        generatedAt: new Date(artifact.generatedAt),
      }).onConflictDoNothing();
      const [stored] = await transaction.select({
        artifactSha256: knowledgeGraphRevision.artifactSha256,
      }).from(knowledgeGraphRevision).where(and(
        eq(knowledgeGraphRevision.organizationId, workspaceId),
        eq(knowledgeGraphRevision.id, artifact.graphRevisionId),
      )).limit(1);
      if (stored?.artifactSha256 !== artifactSha256) throw new Error("revision_reused");
      await transaction.update(knowledgeMappingProposal).set({
        state: "stale",
        decidedAt: new Date(),
      }).where(and(
        eq(knowledgeMappingProposal.organizationId, workspaceId),
        eq(knowledgeMappingProposal.projectEnvironmentId, source.projectEnvironmentId),
        ne(knowledgeMappingProposal.graphRevisionId, artifact.graphRevisionId),
        sql`${knowledgeMappingProposal.state} IN ('proposed', 'approved')`,
      ));
      await transaction.insert(knowledgeEnvironmentHead).values({
        organizationId: workspaceId,
        projectEnvironmentId: source.projectEnvironmentId,
        graphRevisionId: artifact.graphRevisionId,
        environmentRevision: artifact.environmentRevision,
      }).onConflictDoUpdate({
        target: knowledgeEnvironmentHead.projectEnvironmentId,
        set: {
          graphRevisionId: artifact.graphRevisionId,
          environmentRevision: artifact.environmentRevision,
          activatedAt: new Date(),
        },
      });
      await transaction.update(knowledgeSource).set({
        syncState: "ready",
        lastFailureCode: null,
        updatedAt: new Date(),
      }).where(and(
        eq(knowledgeSource.organizationId, workspaceId),
        eq(knowledgeSource.id, sourceId),
      ));
      await transaction.update(knowledgeSourceEvent).set({
        state: "consumed",
        consumedAt: new Date(),
      }).where(and(
        eq(knowledgeSourceEvent.organizationId, workspaceId),
        eq(knowledgeSourceEvent.sourceId, sourceId),
        eq(knowledgeSourceEvent.state, "pending"),
        source.commitSha
          ? eq(knowledgeSourceEvent.afterCommitSha, source.commitSha)
          : sql`FALSE`,
      ));
    });
    return privateJson({
      graphRevisionId: artifact.graphRevisionId,
      artifactSha256,
      active: true,
    }, { status: 201 });
  } catch {
    return jsonError("Knowledge graph activation rejected a stale candidate", 409);
  }
}
