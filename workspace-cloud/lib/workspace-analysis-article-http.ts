// Tenant-scoped Analysis Article projection helpers shared by API routes.
import "server-only";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "./db";
import {
  workspaceAnalysisArticle,
  workspaceAnalysisArticleConnection,
  workspaceAnalysisArticleGraph,
  workspaceAnalysisArticleRevision,
  workspaceConnectionGrant,
} from "./schema";
import {
  parseAnalysisArticleVersionPayload,
  publicAnalysisArticle,
  type AnalysisArticleConnection,
  type AnalysisArticleVersionPayload,
} from "./workspace-analysis-articles";

type ArticleRow = typeof workspaceAnalysisArticle.$inferSelect;

function projection(
  article: ArticleRow,
  revision: number,
  payload: AnalysisArticleVersionPayload | null,
  connections: readonly AnalysisArticleConnection[],
  graphRevisionIds: readonly string[],
) {
  return publicAnalysisArticle({
    id: article.id,
    projectEnvironmentId: payload?.projectEnvironmentId ?? article.projectEnvironmentId,
    environmentRevision: payload?.environmentRevision ?? article.environmentRevision,
    sourceKnowledgeGrantId: payload?.sourceKnowledgeGrantId ?? article.sourceKnowledgeGrantId,
    graphRevisionIds,
    connections,
    definition: payload?.definition ?? article.definition,
    state: payload?.state ?? article.state,
    ownerMemberId: payload?.ownerMemberId ?? article.ownerMemberId,
    updatedByMemberId: article.updatedByMemberId,
    revision,
    liveRevision: article.liveRevision,
    liveRunId: article.liveRunId,
    nextRefreshAt: article.nextRefreshAt,
    latestSuccessfulRunId: article.latestSuccessfulRunId,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  });
}

export async function listAccessibleAnalysisArticles(input: {
  organizationId: string;
  memberId: string;
  includeWorking: boolean;
  articleId?: string;
  projectEnvironmentId?: string;
  includeDeleted?: boolean;
}) {
  const rows = await db.select().from(workspaceAnalysisArticle).where(and(
    eq(workspaceAnalysisArticle.organizationId, input.organizationId),
    input.articleId ? eq(workspaceAnalysisArticle.id, input.articleId) : undefined,
    input.projectEnvironmentId
      ? eq(workspaceAnalysisArticle.projectEnvironmentId, input.projectEnvironmentId)
      : undefined,
    input.includeDeleted ? undefined : isNull(workspaceAnalysisArticle.deletedAt),
  )).orderBy(desc(workspaceAnalysisArticle.updatedAt), desc(workspaceAnalysisArticle.id));
  const selected = rows.flatMap((article) => {
    const revision = input.includeWorking ? article.revision : article.liveRevision;
    return revision === null ? [] : [{ article, revision }];
  });
  if (selected.length === 0) return [];
  const articleIds = selected.map(({ article }) => article.id);
  const historicalTargets = selected.filter(({ article, revision }) => revision !== article.revision);
  const [connectionRows, graphRows, historicalRows] = await Promise.all([
    db.select().from(workspaceAnalysisArticleConnection).where(and(
      eq(workspaceAnalysisArticleConnection.organizationId, input.organizationId),
      inArray(workspaceAnalysisArticleConnection.articleId, articleIds),
    )),
    db.select().from(workspaceAnalysisArticleGraph).where(and(
      eq(workspaceAnalysisArticleGraph.organizationId, input.organizationId),
      inArray(workspaceAnalysisArticleGraph.articleId, articleIds),
    )),
    historicalTargets.length === 0
      ? Promise.resolve([])
      : db.select().from(workspaceAnalysisArticleRevision).where(and(
        eq(workspaceAnalysisArticleRevision.organizationId, input.organizationId),
        inArray(
          workspaceAnalysisArticleRevision.articleId,
          historicalTargets.map(({ article }) => article.id),
        ),
      )),
  ]);
  const requiredConnectionIds = [...new Set(connectionRows.map((row) => row.connectionId))];
  const grants = requiredConnectionIds.length === 0 ? [] : await db.select({
    connectionId: workspaceConnectionGrant.connectionId,
  }).from(workspaceConnectionGrant).where(and(
    eq(workspaceConnectionGrant.organizationId, input.organizationId),
    eq(workspaceConnectionGrant.memberId, input.memberId),
    inArray(workspaceConnectionGrant.connectionId, requiredConnectionIds),
  ));
  const granted = new Set(grants.map((grant) => grant.connectionId));
  const revisionPayload = new Map<string, AnalysisArticleVersionPayload>();
  for (const row of historicalRows) {
    const key = `${row.articleId}:${row.revision}`;
    try {
      revisionPayload.set(key, parseAnalysisArticleVersionPayload(row.payload));
    } catch {
      // A corrupt historical payload is not projected as a different revision.
    }
  }
  return selected.flatMap(({ article, revision }) => {
    const connections = connectionRows
      .filter((row) => row.articleId === article.id && row.articleRevision === revision)
      .map((row) => ({
        connectionId: row.connectionId,
        connectionRevision: row.connectionRevision,
        role: row.role,
        alias: row.alias,
      }));
    if (connections.length === 0 || connections.some((connection) => !granted.has(connection.connectionId))) {
      return [];
    }
    const graphRevisionIds = graphRows
      .filter((row) => row.articleId === article.id && row.articleRevision === revision)
      .map((row) => row.graphRevisionId);
    const payload = revision === article.revision
      ? null
      : revisionPayload.get(`${article.id}:${revision}`) ?? null;
    if (revision !== article.revision && payload === null) return [];
    return [projection(article, revision, payload, connections, graphRevisionIds)];
  });
}

export async function accessibleAnalysisArticle(input: {
  organizationId: string;
  articleId: string;
  memberId: string;
  includeWorking: boolean;
  includeDeleted?: boolean;
}) {
  const rows = await listAccessibleAnalysisArticles({
    ...input,
    articleId: input.articleId,
  });
  return rows[0] ?? null;
}
