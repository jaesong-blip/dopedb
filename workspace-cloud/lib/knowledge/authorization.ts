import "server-only";

import { and, count, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  knowledgeGrant,
  knowledgeGrantGraphRevision,
  knowledgeGraphRevision,
  knowledgeEnvironmentHead,
  knowledgeProjectEnvironment,
  knowledgeSource,
} from "../schema";
import { authorizeWorkspace } from "../workspace-authorization";

export async function authorizeKnowledgeGrant(
  request: Request,
  organizationId: string,
  grantId: string,
) {
  const workspace = await authorizeWorkspace(request, organizationId, "view");
  if (!workspace.ok) return workspace;
  const [grant] = await db.select({
    id: knowledgeGrant.id,
    projectId: knowledgeGrant.projectId,
    projectEnvironmentId: knowledgeGrant.projectEnvironmentId,
    environmentRevision: knowledgeGrant.environmentRevision,
    expiresAt: knowledgeGrant.expiresAt,
  }).from(knowledgeGrant).innerJoin(
    knowledgeProjectEnvironment,
    and(
      eq(knowledgeProjectEnvironment.organizationId, knowledgeGrant.organizationId),
      eq(knowledgeProjectEnvironment.id, knowledgeGrant.projectEnvironmentId),
      eq(knowledgeProjectEnvironment.projectId, knowledgeGrant.projectId),
      eq(knowledgeProjectEnvironment.revision, knowledgeGrant.environmentRevision),
    ),
  ).where(and(
    eq(knowledgeGrant.id, grantId),
    eq(knowledgeGrant.organizationId, organizationId),
    eq(knowledgeGrant.memberId, workspace.membership.id),
    isNull(knowledgeGrant.revokedAt),
    gt(knowledgeGrant.expiresAt, new Date()),
  )).limit(1);
  if (!grant) return { ok: false as const, status: 403, error: "Knowledge grant denied" };
  const revisions = await db.select({
    graphRevisionId: knowledgeGrantGraphRevision.graphRevisionId,
    sourceId: knowledgeGraphRevision.sourceId,
  }).from(knowledgeGrantGraphRevision).innerJoin(
    knowledgeGraphRevision,
    and(
      eq(knowledgeGraphRevision.organizationId, knowledgeGrantGraphRevision.organizationId),
      eq(knowledgeGraphRevision.id, knowledgeGrantGraphRevision.graphRevisionId),
      eq(knowledgeGraphRevision.projectEnvironmentId, grant.projectEnvironmentId),
      eq(knowledgeGraphRevision.environmentRevision, grant.environmentRevision),
    ),
  ).innerJoin(
    knowledgeEnvironmentHead,
    and(
      eq(knowledgeEnvironmentHead.organizationId, knowledgeGraphRevision.organizationId),
      eq(knowledgeEnvironmentHead.projectEnvironmentId, knowledgeGraphRevision.projectEnvironmentId),
      eq(knowledgeEnvironmentHead.sourceId, knowledgeGraphRevision.sourceId),
      eq(knowledgeEnvironmentHead.graphRevisionId, knowledgeGraphRevision.id),
      eq(knowledgeEnvironmentHead.environmentRevision, knowledgeGraphRevision.environmentRevision),
    ),
  ).innerJoin(
    knowledgeSource,
    and(
      eq(knowledgeSource.organizationId, knowledgeGraphRevision.organizationId),
      eq(knowledgeSource.id, knowledgeGraphRevision.sourceId),
      isNull(knowledgeSource.revokedAt),
    ),
  ).where(and(
    eq(knowledgeGrantGraphRevision.organizationId, organizationId),
    eq(knowledgeGrantGraphRevision.grantId, grant.id),
  ));
  const [storedRevisionCount] = await db.select({ value: count() })
    .from(knowledgeGrantGraphRevision)
    .where(and(
      eq(knowledgeGrantGraphRevision.organizationId, organizationId),
      eq(knowledgeGrantGraphRevision.grantId, grant.id),
    ));
  if (
    revisions.length < 1
    || revisions.length !== Number(storedRevisionCount?.value ?? 0)
  ) {
    return { ok: false as const, status: 409, error: "Knowledge grant graph is no longer active" };
  }
  return {
    ...workspace,
    ok: true as const,
    grant: { ...grant, graphRevisionIds: revisions.map((revision) => revision.graphRevisionId) },
    revisions,
  };
}
