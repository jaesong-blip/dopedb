// Atomic persistence for Analysis Article definitions. Every mutation binds the
// active session to one Environment revision, exact connection revisions,
// optional Knowledge graph grant, approved cross-source mappings, and (for a
// schedule) one live Desktop runner before it writes projection, history, and
// audit in the same PostgreSQL statement.
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import { revocationGateLockKey } from "./revocation-gates";
import {
  knowledgeEnvironmentConnection,
  knowledgeEnvironmentHead,
  knowledgeGrant,
  knowledgeGrantGraphRevision,
  knowledgeMappingProposal,
  knowledgeProject,
  knowledgeProjectEnvironment,
  workspaceAnalysisArticle,
  workspaceAnalysisArticleConnection,
  workspaceAnalysisArticleGraph,
  workspaceAnalysisArticleRevision,
  workspaceAnalysisRunner,
  workspaceAuditEvent,
  workspaceConnection,
  workspaceConnectionGrant,
} from "./schema";
import {
  analysisArticleVersionPayload,
  nextAnalysisRefreshAt,
  type AnalysisArticleState,
  type SharedAnalysisArticleCreate,
} from "./workspace-analysis-articles";
import { canonicalHash } from "./workspace-versioning";

export type AnalysisArticleMutationAuthority = Readonly<{
  sessionId: string;
  userId: string;
  membershipId: string;
  role: string;
}>;

export type StoredAnalysisArticle = Readonly<{
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  sourceKnowledgeGrantId: string | null;
  definition: unknown;
  state: AnalysisArticleState;
  ownerMemberId: string;
  updatedByMemberId: string;
  revision: number;
  liveRevision: number | null;
  liveRunId: string | null;
  nextRefreshAt: Date | null;
  latestSuccessfulRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

type RawRow = Record<string, unknown>;

function safeRevision(value: unknown) {
  const revision = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

export function returnedAnalysisArticle(row: RawRow | undefined): StoredAnalysisArticle | null {
  if (!row) return null;
  const environmentRevision = safeRevision(row.environmentRevision);
  const revision = safeRevision(row.revision);
  const liveRevision = row.liveRevision === null ? null : safeRevision(row.liveRevision);
  const validLiveRevision = row.liveRevision === null || liveRevision !== null;
  const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt));
  const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(String(row.updatedAt));
  const nextRefreshAt = row.nextRefreshAt === null
    ? null
    : row.nextRefreshAt instanceof Date ? row.nextRefreshAt : new Date(String(row.nextRefreshAt));
  if (typeof row.id !== "string" || typeof row.projectEnvironmentId !== "string"
    || environmentRevision === null || revision === null || !validLiveRevision
    || !(row.sourceKnowledgeGrantId === null || typeof row.sourceKnowledgeGrantId === "string")
    || typeof row.state !== "string"
    || !["draft", "review", "live", "archived"].includes(row.state)
    || typeof row.ownerMemberId !== "string" || typeof row.updatedByMemberId !== "string"
    || !(row.liveRunId === null || typeof row.liveRunId === "string")
    || (nextRefreshAt !== null && Number.isNaN(nextRefreshAt.valueOf()))
    || !(row.latestSuccessfulRunId === null || typeof row.latestSuccessfulRunId === "string")
    || Number.isNaN(createdAt.valueOf()) || Number.isNaN(updatedAt.valueOf())) return null;
  return {
    id: row.id,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision,
    sourceKnowledgeGrantId: row.sourceKnowledgeGrantId as string | null,
    definition: row.definition,
    state: row.state as AnalysisArticleState,
    ownerMemberId: row.ownerMemberId,
    updatedByMemberId: row.updatedByMemberId,
    revision,
    liveRevision,
    liveRunId: row.liveRunId as string | null,
    nextRefreshAt,
    latestSuccessfulRunId: row.latestSuccessfulRunId as string | null,
    createdAt,
    updatedAt,
  };
}

function articleColumns() {
  return sql`
    article."id"::text AS "id",
    article."project_environment_id"::text AS "projectEnvironmentId",
    article."environment_revision" AS "environmentRevision",
    article."source_knowledge_grant_id"::text AS "sourceKnowledgeGrantId",
    article."definition" AS "definition",
    article."state" AS "state",
    article."owner_member_id" AS "ownerMemberId",
    article."updated_by_member_id" AS "updatedByMemberId",
    article."revision" AS "revision",
    article."live_revision" AS "liveRevision",
    article."live_run_id"::text AS "liveRunId",
    article."next_refresh_at" AS "nextRefreshAt",
    article."latest_successful_run_id"::text AS "latestSuccessfulRunId",
    article."created_at" AS "createdAt",
    article."updated_at" AS "updatedAt"`;
}

function memberLockKey(input: {
  organizationId: string;
  authority: AnalysisArticleMutationAuthority;
}) {
  return revocationGateLockKey({
    kind: "member",
    organizationId: input.organizationId,
    memberId: input.authority.membershipId,
    userId: input.authority.userId,
  });
}

function requestedConnections(article: SharedAnalysisArticleCreate) {
  return article.connections.map((connection) => ({
    connection_id: connection.connectionId,
    connection_revision: connection.connectionRevision,
    role: connection.role,
    alias: connection.alias,
  }));
}

function mappingIds(article: SharedAnalysisArticleCreate) {
  const values = article.definition.transforms.flatMap((transform) => {
    const mapping = transform.config.mappingProposalId;
    return typeof mapping === "string" ? [mapping] : [];
  });
  return [...new Set(values)];
}

function runnerId(article: SharedAnalysisArticleCreate) {
  return article.definition.refresh.mode === "scheduled"
    ? article.definition.refresh.runnerId
    : null;
}

export async function commitAnalysisArticleCreate(input: {
  organizationId: string;
  article: SharedAnalysisArticleCreate;
  authority: AnalysisArticleMutationAuthority;
}): Promise<StoredAnalysisArticle | null> {
  const connections = requestedConnections(input.article);
  const graphs = input.article.graphRevisionIds;
  const mappings = mappingIds(input.article);
  const scheduledRunnerId = runnerId(input.article);
  const payload = analysisArticleVersionPayload({
    ...input.article,
    state: "draft",
    ownerMemberId: input.authority.membershipId,
  });
  const requestId = crypto.randomUUID();
  const result = await db.execute<RawRow>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${memberLockKey(input)}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id", member."role"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN ${knowledgeProjectEnvironment} environment
        ON environment."organization_id" = member."organization_id"
       AND environment."id" = ${input.article.projectEnvironmentId}::uuid
       AND environment."revision" = ${input.article.environmentRevision}
      JOIN ${knowledgeProject} project
        ON project."organization_id" = environment."organization_id"
       AND project."id" = environment."project_id"
       AND project."deleted_at" IS NULL
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."role" IN ('editor', 'admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member, project, environment
    ), knowledge_authority AS MATERIALIZED (
      SELECT authority."id"
      FROM authority
      WHERE ${input.article.sourceKnowledgeGrantId}::uuid IS NULL
        AND ${graphs.length} = 0
      UNION ALL
      SELECT authority."id"
      FROM authority
      JOIN ${knowledgeGrant} knowledge_grant
        ON knowledge_grant."organization_id" = ${input.organizationId}
       AND knowledge_grant."id" = ${input.article.sourceKnowledgeGrantId}::uuid
       AND knowledge_grant."member_id" = authority."id"
       AND knowledge_grant."project_environment_id" = ${input.article.projectEnvironmentId}::uuid
       AND knowledge_grant."environment_revision" = ${input.article.environmentRevision}
       AND knowledge_grant."revoked_at" IS NULL
       AND knowledge_grant."expires_at" > now()
    ), requested_graph AS MATERIALIZED (
      SELECT value::uuid AS graph_revision_id
      FROM jsonb_array_elements_text(${JSON.stringify(graphs)}::jsonb)
    ), graph_authority AS MATERIALIZED (
      SELECT requested.graph_revision_id
      FROM requested_graph requested
      JOIN ${knowledgeGrantGraphRevision} grant_graph
        ON grant_graph."organization_id" = ${input.organizationId}
       AND grant_graph."grant_id" = ${input.article.sourceKnowledgeGrantId}::uuid
       AND grant_graph."graph_revision_id" = requested.graph_revision_id
      JOIN ${knowledgeEnvironmentHead} head
        ON head."organization_id" = grant_graph."organization_id"
       AND head."project_environment_id" = ${input.article.projectEnvironmentId}::uuid
       AND head."environment_revision" = ${input.article.environmentRevision}
       AND head."graph_revision_id" = requested.graph_revision_id
      JOIN knowledge_authority ON TRUE
    ), requested_connection AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(connections)}::jsonb)
        AS requested(connection_id uuid, connection_revision bigint, role text, alias text)
    ), connection_authority AS MATERIALIZED (
      SELECT requested.connection_id
      FROM requested_connection requested
      JOIN ${knowledgeEnvironmentConnection} binding
        ON binding."organization_id" = ${input.organizationId}
       AND binding."project_environment_id" = ${input.article.projectEnvironmentId}::uuid
       AND binding."environment_revision" = ${input.article.environmentRevision}
       AND binding."connection_id" = requested.connection_id
       AND binding."connection_revision" = requested.connection_revision
       AND binding."role" = requested.role
       AND binding."alias" = requested.alias
       AND binding."revoked_at" IS NULL
      JOIN ${workspaceConnection} connection
        ON connection."organization_id" = binding."organization_id"
       AND connection."id" = binding."connection_id"
       AND connection."revision" = binding."connection_revision"
       AND connection."deleted_at" IS NULL
       AND connection."revocation_pending_at" IS NULL
      JOIN ${workspaceConnectionGrant} connection_grant
        ON connection_grant."organization_id" = connection."organization_id"
       AND connection_grant."connection_id" = connection."id"
       AND connection_grant."member_id" = ${input.authority.membershipId}
       AND connection_grant."capability" IN ('use', 'manage')
      JOIN authority ON TRUE
      FOR UPDATE OF binding, connection, connection_grant
    ), requested_mapping AS MATERIALIZED (
      SELECT value::uuid AS mapping_id
      FROM jsonb_array_elements_text(${JSON.stringify(mappings)}::jsonb)
    ), mapping_authority AS MATERIALIZED (
      SELECT requested.mapping_id
      FROM requested_mapping requested
      JOIN ${knowledgeMappingProposal} mapping
        ON mapping."organization_id" = ${input.organizationId}
       AND mapping."id" = requested.mapping_id
       AND mapping."project_environment_id" = ${input.article.projectEnvironmentId}::uuid
       AND mapping."graph_revision_id" IN (SELECT graph_revision_id FROM requested_graph)
       AND mapping."state" = 'approved'
      JOIN knowledge_authority ON TRUE
      FOR UPDATE OF mapping
    ), runner_lock AS MATERIALIZED (
      SELECT runner."member_id"
      FROM ${workspaceAnalysisRunner} runner
      JOIN authority ON authority."id" = runner."member_id"
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."id" = ${scheduledRunnerId}::uuid
        AND runner."background_allowed" = TRUE
        AND runner."revoked_at" IS NULL
        AND runner."last_seen_at" > now() - interval '2 minutes'
      FOR UPDATE OF runner
    ), runner_authority AS MATERIALIZED (
      SELECT authority."id"
      FROM authority
      WHERE ${scheduledRunnerId}::uuid IS NULL
        OR EXISTS (
          SELECT 1 FROM runner_lock WHERE runner_lock."member_id" = authority."id"
        )
    ), inserted AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisArticle} AS inserted_article
        ("id", "organization_id", "project_environment_id", "environment_revision",
         "source_knowledge_grant_id", "definition", "state", "owner_member_id",
         "updated_by_member_id", "revision")
      SELECT ${input.article.id}::uuid, ${input.organizationId},
        ${input.article.projectEnvironmentId}::uuid, ${input.article.environmentRevision},
        ${input.article.sourceKnowledgeGrantId}::uuid,
        ${JSON.stringify(input.article.definition)}::jsonb, 'draft', authority."id",
        authority."id", 1
      FROM authority
      JOIN knowledge_authority ON knowledge_authority."id" = authority."id"
      JOIN runner_authority ON runner_authority."id" = authority."id"
      WHERE (SELECT count(*) FROM graph_authority) = ${graphs.length}
        AND (SELECT count(*) FROM connection_authority) = ${connections.length}
        AND (SELECT count(*) FROM mapping_authority) = ${mappings.length}
      RETURNING inserted_article.*
    ), inserted_connections AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisArticleConnection}
        ("organization_id", "article_id", "article_revision", "connection_id",
         "connection_revision", "role", "alias")
      SELECT ${input.organizationId}, inserted."id", inserted."revision", requested.connection_id,
        requested.connection_revision, requested.role, requested.alias
      FROM inserted CROSS JOIN requested_connection requested
      RETURNING "article_id"
    ), inserted_graphs AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisArticleGraph}
        ("organization_id", "article_id", "article_revision", "graph_revision_id")
      SELECT ${input.organizationId}, inserted."id", inserted."revision", requested.graph_revision_id
      FROM inserted CROSS JOIN requested_graph requested
      RETURNING "article_id"
    ), revision AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisArticleRevision}
        ("organization_id", "article_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_user_id", "created_by_member_id")
      SELECT ${input.organizationId}, inserted."id", 1, 0, 'create',
        ${JSON.stringify(payload)}::jsonb, ${canonicalHash(payload)},
        ${input.authority.userId}, ${input.authority.membershipId}
      FROM inserted
      WHERE (SELECT count(*) FROM inserted_connections) = ${connections.length}
        AND (SELECT count(*) FROM inserted_graphs) = ${graphs.length}
      RETURNING "article_id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'analysis_article.create',
        'analysis_article', inserted."id"::text,
        jsonb_build_object(
          'environmentId', inserted."project_environment_id",
          'environmentRevision', inserted."environment_revision",
          'connectionCount', ${connections.length}::integer,
          'graphCount', ${graphs.length}::integer,
          'queryCount', ${input.article.definition.queries.length}::integer,
          'blockCount', ${input.article.definition.blocks.length}::integer,
          'revision', 1
        ), ${requestId}::uuid
      FROM inserted JOIN revision ON revision."article_id" = inserted."id"
      RETURNING "resource_id"
    )
    SELECT ${articleColumns()}
    FROM inserted article
    JOIN audit ON audit."resource_id" = article."id"::text
  `);
  return returnedAnalysisArticle(result.rows[0]);
}

export type AnalysisArticleMutationOperation =
  | "propose"
  | "update"
  | "submit_review"
  | "return_draft"
  | "publish_live"
  | "archive"
  | "restore"
  | "transfer"
  | "delete";

export async function commitAnalysisArticleMutation(input: {
  organizationId: string;
  article: SharedAnalysisArticleCreate;
  expectedRevision: number;
  state: AnalysisArticleState;
  ownerMemberId: string;
  authority: AnalysisArticleMutationAuthority;
  operation: AnalysisArticleMutationOperation;
}): Promise<StoredAnalysisArticle | null> {
  const connections = requestedConnections(input.article);
  const graphs = input.article.graphRevisionIds;
  const mappings = mappingIds(input.article);
  const scheduledRunnerId = runnerId(input.article);
  const deleted = input.operation === "delete";
  const nextRefreshAt = input.operation === "publish_live"
    ? nextAnalysisRefreshAt(input.article.definition.refresh, new Date())
    : null;
  const payload = analysisArticleVersionPayload({
    ...input.article,
    state: input.state,
    ownerMemberId: input.ownerMemberId,
    deleted,
  });
  const requestId = crypto.randomUUID();
  const result = await db.execute<RawRow>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${memberLockKey(input)}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id", member."role"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN ${knowledgeProjectEnvironment} environment
        ON environment."organization_id" = member."organization_id"
       AND environment."id" = ${input.article.projectEnvironmentId}::uuid
       AND environment."revision" = ${input.article.environmentRevision}
      JOIN ${knowledgeProject} project
        ON project."organization_id" = environment."organization_id"
       AND project."id" = environment."project_id"
       AND (project."deleted_at" IS NULL OR ${deleted})
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."role" IN ('editor', 'admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member, project, environment
    ), target_owner AS MATERIALIZED (
      SELECT owner."id"
      FROM "workspace_control"."member" owner
      JOIN authority ON TRUE
      WHERE owner."organization_id" = ${input.organizationId}
        AND owner."id" = ${input.ownerMemberId}
        AND owner."role" IN ('editor', 'admin', 'owner')
        AND owner."revocation_pending_at" IS NULL
        AND owner."revocation_claim_id" IS NULL
      FOR UPDATE OF owner
    ), current AS MATERIALIZED (
      SELECT article."id", article."organization_id"
      FROM ${workspaceAnalysisArticle} article
      JOIN authority ON TRUE
      JOIN target_owner ON TRUE
      WHERE article."organization_id" = ${input.organizationId}
        AND article."id" = ${input.article.id}::uuid
        AND article."project_environment_id" = ${input.article.projectEnvironmentId}::uuid
        AND article."revision" = ${input.expectedRevision}
        AND article."deleted_at" IS NULL
        AND (article."owner_member_id" = authority."id" OR authority."role" IN ('admin', 'owner'))
      FOR UPDATE OF article
    ), knowledge_authority AS MATERIALIZED (
      SELECT authority."id" FROM authority
      WHERE ${input.article.sourceKnowledgeGrantId}::uuid IS NULL AND ${graphs.length} = 0
      UNION ALL
      SELECT authority."id"
      FROM authority
      JOIN ${knowledgeGrant} knowledge_grant
        ON knowledge_grant."organization_id" = ${input.organizationId}
       AND knowledge_grant."id" = ${input.article.sourceKnowledgeGrantId}::uuid
       AND knowledge_grant."member_id" = authority."id"
       AND knowledge_grant."project_environment_id" = ${input.article.projectEnvironmentId}::uuid
       AND knowledge_grant."environment_revision" = ${input.article.environmentRevision}
       AND knowledge_grant."revoked_at" IS NULL AND knowledge_grant."expires_at" > now()
    ), requested_graph AS MATERIALIZED (
      SELECT value::uuid AS graph_revision_id
      FROM jsonb_array_elements_text(${JSON.stringify(graphs)}::jsonb)
    ), graph_authority AS MATERIALIZED (
      SELECT requested.graph_revision_id
      FROM requested_graph requested
      JOIN ${knowledgeGrantGraphRevision} grant_graph
        ON grant_graph."organization_id" = ${input.organizationId}
       AND grant_graph."grant_id" = ${input.article.sourceKnowledgeGrantId}::uuid
       AND grant_graph."graph_revision_id" = requested.graph_revision_id
      JOIN ${knowledgeEnvironmentHead} head
        ON head."organization_id" = grant_graph."organization_id"
       AND head."project_environment_id" = ${input.article.projectEnvironmentId}::uuid
       AND head."environment_revision" = ${input.article.environmentRevision}
       AND head."graph_revision_id" = requested.graph_revision_id
      JOIN knowledge_authority ON TRUE
    ), requested_connection AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(connections)}::jsonb)
        AS requested(connection_id uuid, connection_revision bigint, role text, alias text)
    ), connection_authority AS MATERIALIZED (
      SELECT requested.connection_id
      FROM requested_connection requested
      JOIN ${knowledgeEnvironmentConnection} binding
        ON binding."organization_id" = ${input.organizationId}
       AND binding."project_environment_id" = ${input.article.projectEnvironmentId}::uuid
       AND binding."environment_revision" = ${input.article.environmentRevision}
       AND binding."connection_id" = requested.connection_id
       AND binding."connection_revision" = requested.connection_revision
       AND binding."role" = requested.role AND binding."alias" = requested.alias
       AND binding."revoked_at" IS NULL
      JOIN ${workspaceConnection} connection
        ON connection."organization_id" = binding."organization_id"
       AND connection."id" = binding."connection_id"
       AND connection."revision" = binding."connection_revision"
       AND connection."deleted_at" IS NULL AND connection."revocation_pending_at" IS NULL
      JOIN ${workspaceConnectionGrant} connection_grant
        ON connection_grant."organization_id" = connection."organization_id"
       AND connection_grant."connection_id" = connection."id"
       AND connection_grant."member_id" = ${input.authority.membershipId}
       AND connection_grant."capability" IN ('use', 'manage')
      JOIN current ON TRUE
      FOR UPDATE OF binding, connection, connection_grant
    ), requested_mapping AS MATERIALIZED (
      SELECT value::uuid AS mapping_id
      FROM jsonb_array_elements_text(${JSON.stringify(mappings)}::jsonb)
    ), mapping_authority AS MATERIALIZED (
      SELECT requested.mapping_id
      FROM requested_mapping requested
      JOIN ${knowledgeMappingProposal} mapping
        ON mapping."organization_id" = ${input.organizationId}
       AND mapping."id" = requested.mapping_id
       AND mapping."project_environment_id" = ${input.article.projectEnvironmentId}::uuid
       AND mapping."graph_revision_id" IN (SELECT graph_revision_id FROM requested_graph)
       AND mapping."state" = 'approved'
      JOIN knowledge_authority ON TRUE
      FOR UPDATE OF mapping
    ), runner_lock AS MATERIALIZED (
      SELECT runner."member_id"
      FROM ${workspaceAnalysisRunner} runner
      JOIN authority ON authority."id" = runner."member_id"
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."id" = ${scheduledRunnerId}::uuid
        AND runner."background_allowed" = TRUE
        AND runner."revoked_at" IS NULL
        AND runner."last_seen_at" > now() - interval '2 minutes'
      FOR UPDATE OF runner
    ), runner_authority AS MATERIALIZED (
      SELECT authority."id"
      FROM authority
      WHERE ${scheduledRunnerId}::uuid IS NULL
        OR EXISTS (
          SELECT 1 FROM runner_lock WHERE runner_lock."member_id" = authority."id"
        )
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceAnalysisArticle} article
      SET "project_environment_id" = ${input.article.projectEnvironmentId}::uuid,
        "environment_revision" = ${input.article.environmentRevision},
        "source_knowledge_grant_id" = ${input.article.sourceKnowledgeGrantId}::uuid,
        "definition" = ${JSON.stringify(input.article.definition)}::jsonb,
        "state" = ${input.state}, "owner_member_id" = ${input.ownerMemberId},
        "updated_by_member_id" = ${input.authority.membershipId},
        "revision" = article."revision" + 1, "updated_at" = now(),
        "live_revision" = CASE
          WHEN ${input.operation} = 'publish_live' THEN article."revision" + 1
          ELSE article."live_revision"
        END,
        "live_run_id" = CASE
          WHEN ${input.operation} = 'publish_live' THEN article."latest_successful_run_id"
          ELSE article."live_run_id"
        END,
        "next_refresh_at" = CASE
          WHEN ${input.operation} = 'publish_live' THEN ${nextRefreshAt}
          WHEN ${input.operation} IN ('archive', 'delete') THEN NULL
          ELSE article."next_refresh_at"
        END,
        "deleted_at" = CASE WHEN ${deleted} THEN now() ELSE NULL END
      FROM current, knowledge_authority, runner_authority
      WHERE article."organization_id" = current."organization_id"
        AND article."id" = current."id"
        AND (SELECT count(*) FROM graph_authority) = ${graphs.length}
        AND (SELECT count(*) FROM connection_authority) = ${connections.length}
        AND (SELECT count(*) FROM mapping_authority) = ${mappings.length}
      RETURNING article.*
    ), inserted_connections AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisArticleConnection}
        ("organization_id", "article_id", "article_revision", "connection_id",
         "connection_revision", "role", "alias")
      SELECT ${input.organizationId}, updated."id", updated."revision", requested.connection_id,
        requested.connection_revision, requested.role, requested.alias
      FROM updated CROSS JOIN requested_connection requested
      RETURNING "article_id"
    ), inserted_graphs AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisArticleGraph}
        ("organization_id", "article_id", "article_revision", "graph_revision_id")
      SELECT ${input.organizationId}, updated."id", updated."revision", requested.graph_revision_id
      FROM updated CROSS JOIN requested_graph requested
      RETURNING "article_id"
    ), revision AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisArticleRevision}
        ("organization_id", "article_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_user_id", "created_by_member_id")
      SELECT ${input.organizationId}, updated."id", updated."revision", ${input.expectedRevision},
        ${input.operation}, ${JSON.stringify(payload)}::jsonb, ${canonicalHash(payload)},
        ${input.authority.userId}, ${input.authority.membershipId}
      FROM updated
      WHERE (SELECT count(*) FROM inserted_connections) = ${connections.length}
        AND (SELECT count(*) FROM inserted_graphs) = ${graphs.length}
      RETURNING "article_id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        ${`analysis_article.${input.operation}`}, 'analysis_article', updated."id"::text,
        jsonb_build_object(
          'environmentId', updated."project_environment_id",
          'state', updated."state", 'revision', updated."revision",
          'ownerMemberId', updated."owner_member_id",
          'connectionCount', ${connections.length}::integer,
          'graphCount', ${graphs.length}::integer
        ), ${requestId}::uuid
      FROM updated JOIN revision ON revision."article_id" = updated."id"
      RETURNING "resource_id"
    )
    SELECT ${articleColumns()}
    FROM updated article
    JOIN audit ON audit."resource_id" = article."id"::text
  `);
  const article = returnedAnalysisArticle(result.rows[0]);
  if (article && article.revision !== input.expectedRevision + 1) {
    throw new Error("Analysis Article revision did not advance exactly once");
  }
  return article;
}
