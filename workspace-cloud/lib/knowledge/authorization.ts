import "server-only";

import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  knowledgeGrant,
  knowledgeGraphRevision,
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
    graphRevisionId: knowledgeGrant.graphRevisionId,
    expiresAt: knowledgeGrant.expiresAt,
  }).from(knowledgeGrant).innerJoin(
    knowledgeProjectEnvironment,
    and(
      eq(knowledgeProjectEnvironment.organizationId, knowledgeGrant.organizationId),
      eq(knowledgeProjectEnvironment.id, knowledgeGrant.projectEnvironmentId),
      eq(knowledgeProjectEnvironment.projectId, knowledgeGrant.projectId),
      eq(knowledgeProjectEnvironment.revision, knowledgeGrant.environmentRevision),
    ),
  ).innerJoin(
    knowledgeGraphRevision,
    and(
      eq(knowledgeGraphRevision.organizationId, knowledgeGrant.organizationId),
      eq(knowledgeGraphRevision.id, knowledgeGrant.graphRevisionId),
      eq(knowledgeGraphRevision.projectEnvironmentId, knowledgeGrant.projectEnvironmentId),
      eq(knowledgeGraphRevision.environmentRevision, knowledgeGrant.environmentRevision),
    ),
  ).innerJoin(
    knowledgeSource,
    and(
      eq(knowledgeSource.organizationId, knowledgeGraphRevision.organizationId),
      eq(knowledgeSource.id, knowledgeGraphRevision.sourceId),
      isNull(knowledgeSource.revokedAt),
    ),
  ).where(and(
    eq(knowledgeGrant.id, grantId),
    eq(knowledgeGrant.organizationId, organizationId),
    eq(knowledgeGrant.memberId, workspace.membership.id),
    isNull(knowledgeGrant.revokedAt),
    gt(knowledgeGrant.expiresAt, new Date()),
  )).limit(1);
  if (!grant) return { ok: false as const, status: 403, error: "Knowledge grant denied" };
  return { ...workspace, ok: true as const, grant };
}
