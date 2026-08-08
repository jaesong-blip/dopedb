// Atomic publication for Environment funnel analysis definitions. Publication
// rechecks the session, member, exact KnowledgeGrant graph set, Environment DB
// bindings, connection grants, dashboard revisions, and confirmed mappings in
// the same statement that writes the immutable revision and audit event.
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import {
  knowledgeEnvironmentConnection,
  knowledgeEnvironmentHead,
  knowledgeGrant,
  knowledgeGrantGraphRevision,
  knowledgeMappingProposal,
  knowledgeProjectEnvironment,
  workspaceAuditEvent,
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceDashboard,
  workspaceFunnelAnalysis,
  workspaceFunnelAnalysisConnection,
  workspaceFunnelAnalysisGraph,
  workspaceFunnelAnalysisRevision,
} from "./schema";
import type { DashboardMutationAuthority } from "./workspace-dashboard-store";
import type { SharedFunnelAnalysisCreate } from "./workspace-funnel-analyses";
import { canonicalHash } from "./workspace-versioning";

type ReturnedAnalysis = Readonly<{
  id: string;
  revision: number;
  state: string;
}>;

function safeRevision(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

export async function commitFunnelAnalysisPublish(input: {
  organizationId: string;
  analysis: SharedFunnelAnalysisCreate;
  authority: DashboardMutationAuthority;
}): Promise<ReturnedAnalysis | null> {
  const requestedConnections = input.analysis.connections.map((connection) => ({
    connection_id: connection.connectionId,
    connection_revision: connection.connectionRevision,
    role: connection.role,
    alias: connection.alias,
  }));
  const requestedGraphs = input.analysis.graphRevisionIds;
  const requestedDashboards = input.analysis.definition.tiles.flatMap((tile) => {
    const dashboardId = tile.dashboardId;
    const dashboardRevision = tile.expectedDashboardRevision;
    return typeof dashboardId === "string" && typeof dashboardRevision === "number"
      ? [{ dashboard_id: dashboardId, dashboard_revision: dashboardRevision }]
      : [];
  });
  if (requestedDashboards.length === 0) return null;
  const requestedMappings = input.analysis.definition.steps.flatMap((step) =>
    step.mappingState === "confirmed" && typeof step.mappingProposalId === "string"
      ? [step.mappingProposalId]
      : []
  );
  const payload = {
    projectEnvironmentId: input.analysis.projectEnvironmentId,
    environmentRevision: input.analysis.environmentRevision,
    sourceKnowledgeGrantId: input.analysis.sourceKnowledgeGrantId,
    graphRevisionIds: requestedGraphs,
    connections: input.analysis.connections,
    definition: input.analysis.definition,
    state: "published",
  };
  const requestId = crypto.randomUUID();
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN ${knowledgeGrant} grant
        ON grant."id" = ${input.analysis.sourceKnowledgeGrantId}::uuid
       AND grant."organization_id" = member."organization_id"
       AND grant."member_id" = member."id"
       AND grant."project_environment_id" = ${input.analysis.projectEnvironmentId}::uuid
       AND grant."environment_revision" = ${input.analysis.environmentRevision}
       AND grant."revoked_at" IS NULL
       AND grant."expires_at" > now()
      JOIN ${knowledgeProjectEnvironment} environment
        ON environment."organization_id" = grant."organization_id"
       AND environment."id" = grant."project_environment_id"
       AND environment."revision" = grant."environment_revision"
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."role" IN ('editor', 'admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member, grant, environment
    ), requested_graph AS MATERIALIZED (
      SELECT value::uuid AS graph_revision_id
      FROM jsonb_array_elements_text(${JSON.stringify(requestedGraphs)}::jsonb)
    ), graph_authority AS MATERIALIZED (
      SELECT requested_graph.graph_revision_id
      FROM requested_graph
      JOIN ${knowledgeGrantGraphRevision} grant_graph
        ON grant_graph."organization_id" = ${input.organizationId}
       AND grant_graph."grant_id" = ${input.analysis.sourceKnowledgeGrantId}::uuid
       AND grant_graph."graph_revision_id" = requested_graph.graph_revision_id
      JOIN ${knowledgeEnvironmentHead} head
        ON head."organization_id" = grant_graph."organization_id"
       AND head."project_environment_id" = ${input.analysis.projectEnvironmentId}::uuid
       AND head."environment_revision" = ${input.analysis.environmentRevision}
       AND head."graph_revision_id" = grant_graph."graph_revision_id"
      JOIN authority ON TRUE
    ), requested_connection AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(requestedConnections)}::jsonb)
        AS requested(connection_id uuid, connection_revision bigint, role text, alias text)
    ), connection_authority AS MATERIALIZED (
      SELECT requested.connection_id
      FROM requested_connection requested
      JOIN ${knowledgeEnvironmentConnection} binding
        ON binding."organization_id" = ${input.organizationId}
       AND binding."project_environment_id" = ${input.analysis.projectEnvironmentId}::uuid
       AND binding."environment_revision" = ${input.analysis.environmentRevision}
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
    ), requested_dashboard AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(requestedDashboards)}::jsonb)
        AS requested(dashboard_id uuid, dashboard_revision bigint)
    ), dashboard_authority AS MATERIALIZED (
      SELECT requested.dashboard_id
      FROM requested_dashboard requested
      JOIN ${workspaceDashboard} dashboard
        ON dashboard."organization_id" = ${input.organizationId}
       AND dashboard."id" = requested.dashboard_id
       AND dashboard."revision" = requested.dashboard_revision
       AND dashboard."deleted_at" IS NULL
      JOIN connection_authority connection
        ON connection.connection_id = dashboard."connection_id"
      JOIN authority ON TRUE
      FOR UPDATE OF dashboard
    ), requested_mapping AS MATERIALIZED (
      SELECT value::uuid AS mapping_id
      FROM jsonb_array_elements_text(${JSON.stringify(requestedMappings)}::jsonb)
    ), mapping_authority AS MATERIALIZED (
      SELECT requested.mapping_id
      FROM requested_mapping requested
      JOIN ${knowledgeMappingProposal} mapping
        ON mapping."organization_id" = ${input.organizationId}
       AND mapping."id" = requested.mapping_id
       AND mapping."project_environment_id" = ${input.analysis.projectEnvironmentId}::uuid
       AND mapping."graph_revision_id" IN (SELECT graph_revision_id FROM requested_graph)
       AND mapping."state" = 'approved'
      JOIN authority ON TRUE
      FOR UPDATE OF mapping
    ), inserted AS MATERIALIZED (
      INSERT INTO ${workspaceFunnelAnalysis} analysis
        ("id", "organization_id", "project_environment_id", "environment_revision",
         "source_knowledge_grant_id", "definition", "state", "owner_member_id",
         "updated_by_member_id", "revision")
      SELECT ${input.analysis.id}::uuid, ${input.organizationId},
        ${input.analysis.projectEnvironmentId}::uuid, ${input.analysis.environmentRevision},
        ${input.analysis.sourceKnowledgeGrantId}::uuid,
        ${JSON.stringify(input.analysis.definition)}::jsonb, 'published', authority."id",
        authority."id", 1
      FROM authority
      WHERE (SELECT count(*) FROM graph_authority) = ${requestedGraphs.length}
        AND (SELECT count(*) FROM ${knowledgeGrantGraphRevision}
             WHERE "organization_id" = ${input.organizationId}
               AND "grant_id" = ${input.analysis.sourceKnowledgeGrantId}::uuid) = ${requestedGraphs.length}
        AND (SELECT count(*) FROM connection_authority) = ${requestedConnections.length}
        AND (SELECT count(*) FROM dashboard_authority) = ${requestedDashboards.length}
        AND (SELECT count(*) FROM mapping_authority) = ${requestedMappings.length}
      RETURNING analysis.*
    ), inserted_connections AS MATERIALIZED (
      INSERT INTO ${workspaceFunnelAnalysisConnection}
        ("organization_id", "analysis_id", "connection_id", "connection_revision", "role", "alias")
      SELECT ${input.organizationId}, inserted."id", requested.connection_id,
        requested.connection_revision, requested.role, requested.alias
      FROM inserted CROSS JOIN requested_connection requested
      RETURNING "analysis_id"
    ), inserted_graphs AS MATERIALIZED (
      INSERT INTO ${workspaceFunnelAnalysisGraph}
        ("organization_id", "analysis_id", "graph_revision_id")
      SELECT ${input.organizationId}, inserted."id", requested.graph_revision_id
      FROM inserted CROSS JOIN requested_graph requested
      RETURNING "analysis_id"
    ), revision AS MATERIALIZED (
      INSERT INTO ${workspaceFunnelAnalysisRevision}
        ("organization_id", "analysis_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_user_id", "created_by_member_id")
      SELECT ${input.organizationId}, inserted."id", 1, 0, 'publish',
        ${JSON.stringify(payload)}::jsonb, ${canonicalHash(payload)},
        ${input.authority.userId}, ${input.authority.membershipId}
      FROM inserted
      WHERE (SELECT count(*) FROM inserted_connections) = ${requestedConnections.length}
        AND (SELECT count(*) FROM inserted_graphs) = ${requestedGraphs.length}
      RETURNING "analysis_id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'funnel_analysis.publish',
        'funnel_analysis', inserted."id"::text,
        jsonb_build_object(
          'environmentId', inserted."project_environment_id",
          'environmentRevision', inserted."environment_revision",
          'connectionCount', ${requestedConnections.length},
          'graphCount', ${requestedGraphs.length},
          'tileCount', ${input.analysis.definition.tiles.length},
          'revision', inserted."revision"
        ), ${requestId}::uuid
      FROM inserted JOIN revision ON revision."analysis_id" = inserted."id"
      RETURNING "resource_id"
    )
    SELECT inserted."id"::text AS "id", inserted."revision" AS "revision",
           inserted."state" AS "state"
    FROM inserted JOIN audit ON audit."resource_id" = inserted."id"::text
  `);
  const row = result.rows[0];
  const revision = safeRevision(row?.revision);
  return row && typeof row.id === "string" && typeof row.state === "string" && revision
    ? { id: row.id, revision, state: row.state }
    : null;
}
