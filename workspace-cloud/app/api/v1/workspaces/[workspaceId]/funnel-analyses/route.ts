// Published Environment funnel analyses. Definitions and provenance cross this
// boundary; result rows and credentials never do.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../../../../../../lib/db";
import { env } from "../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../lib/http";
import {
  workspaceConnectionGrant,
  workspaceDashboard,
  workspaceFunnelAnalysis,
  workspaceFunnelAnalysisConnection,
  workspaceFunnelAnalysisGraph,
} from "../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../lib/workspace-authorization";
import { hasWorkspaceCapability } from "../../../../../../lib/workspace-permissions";
import { commitFunnelAnalysisPublish } from "../../../../../../lib/workspace-funnel-analysis-store";
import {
  parseSharedFunnelAnalysisCreate,
  publicFunnelAnalysis,
} from "../../../../../../lib/workspace-funnel-analyses";
import { parseExpectedRevision } from "../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ workspaceId: string }> };

function authority(authorization: {
  role: string;
  session: { session: { id: string }; user: { id: string } };
  membership: { id: string };
}) {
  return {
    sessionId: authorization.session.session.id,
    userId: authorization.session.user.id,
    membershipId: authorization.membership.id,
    role: authorization.role,
  };
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const analyses = await db.select().from(workspaceFunnelAnalysis).where(and(
    eq(workspaceFunnelAnalysis.organizationId, workspaceId),
    eq(workspaceFunnelAnalysis.state, "published"),
    isNull(workspaceFunnelAnalysis.deletedAt),
  )).orderBy(desc(workspaceFunnelAnalysis.updatedAt), desc(workspaceFunnelAnalysis.id));
  if (analyses.length === 0) return privateJson({ workspaceId, analyses: [] });
  const analysisIds = analyses.map((analysis) => analysis.id);
  const [connectionRows, graphRows] = await Promise.all([
    db.select().from(workspaceFunnelAnalysisConnection).where(and(
      eq(workspaceFunnelAnalysisConnection.organizationId, workspaceId),
      inArray(workspaceFunnelAnalysisConnection.analysisId, analysisIds),
    )),
    db.select().from(workspaceFunnelAnalysisGraph).where(and(
      eq(workspaceFunnelAnalysisGraph.organizationId, workspaceId),
      inArray(workspaceFunnelAnalysisGraph.analysisId, analysisIds),
    )),
  ]);
  const dashboardIds = analyses.flatMap((analysis) => {
    const definition = analysis.definition as { tiles?: Array<{ dashboardId?: unknown }> };
    return definition.tiles?.flatMap((tile) =>
      typeof tile.dashboardId === "string" && isUuid(tile.dashboardId) ? [tile.dashboardId] : []
    ) ?? [];
  });
  const availableDashboards = dashboardIds.length === 0 ? [] : await db
    .select({ dashboard: workspaceDashboard })
    .from(workspaceDashboard)
    .innerJoin(
      workspaceConnectionGrant,
      and(
        eq(workspaceConnectionGrant.organizationId, workspaceDashboard.organizationId),
        eq(workspaceConnectionGrant.connectionId, workspaceDashboard.connectionId),
        eq(workspaceConnectionGrant.memberId, authorization.membership.id),
      ),
    )
    .where(and(
      eq(workspaceDashboard.organizationId, workspaceId),
      inArray(workspaceDashboard.id, dashboardIds),
      isNull(workspaceDashboard.deletedAt),
    ));
  return privateJson({
    workspaceId,
    analyses: analyses.map((analysis) => {
      const definition = analysis.definition as { tiles?: Array<{ dashboardId?: unknown }> };
      const analysisDashboardIds = definition.tiles?.flatMap((tile) =>
        typeof tile.dashboardId === "string" && isUuid(tile.dashboardId) ? [tile.dashboardId] : []
      ) ?? [];
      return {
        ...publicFunnelAnalysis(
        analysis,
        graphRows.filter((row) => row.analysisId === analysis.id).map((row) => row.graphRevisionId),
        connectionRows.filter((row) => row.analysisId === analysis.id).map((row) => ({
          connectionId: row.connectionId,
          connectionRevision: row.connectionRevision,
          role: row.role,
          alias: row.alias,
        })),
        ),
        dashboards: availableDashboards
          .map(({ dashboard }) => dashboard)
          .filter((dashboard) => analysisDashboardIds.includes(dashboard.id))
          .map((dashboard) => ({
            id: dashboard.id,
            connectionId: dashboard.connectionId,
            revision: dashboard.revision,
            title: dashboard.title,
            description: dashboard.description,
            sql: dashboard.sql,
            visualization: dashboard.visualization,
            createdAt: dashboard.createdAt.toISOString(),
            updatedAt: dashboard.updatedAt.toISOString(),
          })),
      };
    }),
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Funnel analysis publishing requires workspace Editor access", 403);
  }
  let expectedRevision: number | null;
  try {
    expectedRevision = parseExpectedRevision(request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid If-Match", 400);
  }
  if (expectedRevision === null) return jsonError("If-Match is required", 428);
  if (expectedRevision !== 0) return jsonError("New analyses require If-Match: \"0\"", 409);
  const body = await boundedJsonBody(request, 1024 * 1024);
  if (!body.ok) return jsonError("Invalid funnel analysis request", 400);
  let analysis;
  try {
    analysis = parseSharedFunnelAnalysisCreate(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid funnel analysis", 400);
  }
  try {
    const published = await commitFunnelAnalysisPublish({
      organizationId: workspaceId,
      analysis,
      authority: authority(authorization),
    });
    if (!published) {
      return jsonError(
        "Funnel authority changed. Refresh grants, dashboards, mappings, and Environment revisions before publishing.",
        409,
      );
    }
    return privateJson({ analysis: published }, { status: 201 });
  } catch (error) {
    const row = error && typeof error === "object"
      ? error as { code?: unknown; cause?: { code?: unknown } }
      : null;
    if (row?.code === "23505" || row?.cause?.code === "23505") {
      return jsonError("Funnel analysis already exists; create an explicit conflict copy", 409);
    }
    throw error;
  }
}
