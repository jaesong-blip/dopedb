// Immutable dashboard history. Payloads are revalidated through the same
// allowlist used for current definitions before they leave the control plane.
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "../../../../../../../../lib/db";
import { isUuid, jsonError, privateJson } from "../../../../../../../../lib/http";
import {
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceDashboard,
  workspaceDashboardRevision,
} from "../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";
import { parseDashboardVersionPayload } from "../../../../../../../../lib/workspace-dashboards";
import { hasWorkspaceCapability } from "../../../../../../../../lib/workspace-permissions";

type RouteContext = { params: Promise<{ workspaceId: string; dashboardId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, dashboardId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(dashboardId)) {
    return jsonError("Invalid workspace or dashboard id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Dashboard history requires workspace Editor access", 403);
  }
  const rows = await db.select({ revision: workspaceDashboardRevision })
    .from(workspaceDashboardRevision)
    .innerJoin(
      workspaceDashboard,
      and(
        eq(workspaceDashboard.organizationId, workspaceDashboardRevision.organizationId),
        eq(workspaceDashboard.id, workspaceDashboardRevision.dashboardId),
      ),
    )
    .innerJoin(
      workspaceConnectionGrant,
      and(
        eq(workspaceConnectionGrant.organizationId, workspaceDashboard.organizationId),
        eq(workspaceConnectionGrant.connectionId, workspaceDashboard.connectionId),
        eq(workspaceConnectionGrant.memberId, authorization.membership.id),
      ),
    )
    .innerJoin(
      workspaceConnection,
      and(
        eq(workspaceConnection.organizationId, workspaceDashboard.organizationId),
        eq(workspaceConnection.id, workspaceDashboard.connectionId),
        isNull(workspaceConnection.deletedAt),
      ),
    )
    .where(and(
      eq(workspaceDashboardRevision.organizationId, workspaceId),
      eq(workspaceDashboardRevision.dashboardId, dashboardId),
    ))
    .orderBy(desc(workspaceDashboardRevision.revision))
    .limit(100);
  if (rows.length === 0) return jsonError("Dashboard not found", 404);
  try {
    return privateJson({
      dashboardId,
      revisions: rows.map(({ revision }) => ({
        revision: revision.revision,
        baseRevision: revision.baseRevision,
        operation: revision.operation,
        payload: parseDashboardVersionPayload(revision.payload),
        createdByMemberId: revision.createdByMemberId,
        createdAt: revision.createdAt.toISOString(),
      })),
    });
  } catch {
    return jsonError("Dashboard history is invalid", 409);
  }
}
