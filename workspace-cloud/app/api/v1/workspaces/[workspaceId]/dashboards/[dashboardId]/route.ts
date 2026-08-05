// One shared dashboard's optimistic mutation surface. Stale content edits become
// a separate draft dashboard so neither definition is silently overwritten.
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../../../../../../lib/db";
import { env } from "../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../lib/http";
import {
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceDashboard,
  workspaceDashboardRevision,
} from "../../../../../../../lib/schema";
import { authorizeWorkspace, authorizeWorkspaceConnection } from "../../../../../../../lib/workspace-authorization";
import {
  commitDashboardCreate,
  commitDashboardMutation,
  type DashboardMutationAuthority,
} from "../../../../../../../lib/workspace-dashboard-store";
import {
  parseDashboardVersionPayload,
  parseSharedDashboardDefinition,
  publicDashboard,
  type SharedDashboardDefinition,
} from "../../../../../../../lib/workspace-dashboards";
import { hasWorkspaceCapability } from "../../../../../../../lib/workspace-permissions";
import {
  canonicalHash,
  parseExpectedRevision,
} from "../../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ workspaceId: string; dashboardId: string }> };

type AccessibleDashboard = typeof workspaceDashboard.$inferSelect;

function authority(authorization: {
  role: string;
  session: { session: { id: string }; user: { id: string } };
  membership: { id: string };
}): DashboardMutationAuthority {
  return {
    sessionId: authorization.session.session.id,
    userId: authorization.session.user.id,
    membershipId: authorization.membership.id,
    role: authorization.role,
  };
}

async function accessibleDashboard(
  organizationId: string,
  dashboardId: string,
  memberId: string,
  includeUnpublished: boolean,
  includeDeleted = false,
): Promise<AccessibleDashboard | null> {
  const [row] = await db.select({ dashboard: workspaceDashboard })
    .from(workspaceDashboard)
    .innerJoin(
      workspaceConnectionGrant,
      and(
        eq(workspaceConnectionGrant.organizationId, workspaceDashboard.organizationId),
        eq(workspaceConnectionGrant.connectionId, workspaceDashboard.connectionId),
        eq(workspaceConnectionGrant.memberId, memberId),
      ),
    )
    .innerJoin(
      workspaceConnection,
      and(
        eq(workspaceConnection.organizationId, workspaceDashboard.organizationId),
        eq(workspaceConnection.id, workspaceDashboard.connectionId),
        isNull(workspaceConnection.deletedAt),
        isNull(workspaceConnection.revocationPendingAt),
      ),
    )
    .where(and(
      eq(workspaceDashboard.organizationId, organizationId),
      eq(workspaceDashboard.id, dashboardId),
      includeDeleted ? undefined : isNull(workspaceDashboard.deletedAt),
      includeUnpublished ? undefined : eq(workspaceDashboard.state, "published"),
    ))
    .limit(1);
  return row?.dashboard ?? null;
}

function currentDefinition(dashboard: AccessibleDashboard): SharedDashboardDefinition {
  return parseSharedDashboardDefinition({
    title: dashboard.title,
    description: dashboard.description,
    sql: dashboard.sql,
    visualization: dashboard.visualization,
  });
}

function conflictTitle(title: string) {
  const suffix = " (conflict copy)";
  return [...title].slice(0, 120 - [...suffix].length).join("") + suffix;
}

function sameDashboardOutcome(
  dashboard: AccessibleDashboard,
  expectedRevision: number,
  definition: SharedDashboardDefinition,
  state: "draft" | "published" | "archived",
  ownerMemberId: string,
) {
  const nextRevision = expectedRevision + 1;
  return Number.isSafeInteger(nextRevision)
    && dashboard.revision === nextRevision
    && dashboard.state === state
    && dashboard.ownerMemberId === ownerMemberId
    && canonicalHash(currentDefinition(dashboard)) === canonicalHash(definition);
}

async function expectedRevision(request: Request) {
  try {
    const value = parseExpectedRevision(request);
    if (value === null) return { error: jsonError("If-Match is required", 428) } as const;
    return { value } as const;
  } catch (error) {
    return {
      error: jsonError(error instanceof Error ? error.message : "Invalid If-Match", 400),
    } as const;
  }
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, dashboardId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(dashboardId)) {
    return jsonError("Invalid workspace or dashboard id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const dashboard = await accessibleDashboard(
    workspaceId,
    dashboardId,
    authorization.membership.id,
    hasWorkspaceCapability(authorization.role, "write"),
  );
  if (!dashboard) return jsonError("Dashboard not found", 404);
  if (!dashboard.ownerMemberId) return jsonError("Dashboard owner is unavailable", 409);
  return privateJson({ dashboard: publicDashboard(dashboard) });
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, dashboardId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(dashboardId)) {
    return jsonError("Invalid workspace or dashboard id", 400);
  }
  const workspace = await authorizeWorkspace(request, workspaceId, "write");
  if (!workspace.ok) return jsonError(workspace.error, workspace.status);
  const dashboard = await accessibleDashboard(
    workspaceId,
    dashboardId,
    workspace.membership.id,
    true,
  );
  if (!dashboard) return jsonError("Dashboard not found", 404);
  if (!dashboard.ownerMemberId) return jsonError("Dashboard owner is unavailable", 409);
  const connectionAuthorization = await authorizeWorkspaceConnection(
    request,
    workspaceId,
    dashboard.connectionId,
    "use",
  );
  if (!connectionAuthorization.ok) {
    return jsonError(connectionAuthorization.error, connectionAuthorization.status);
  }
  if (!hasWorkspaceCapability(connectionAuthorization.role, "write")) {
    return jsonError("Dashboard editing requires workspace Editor access", 403);
  }
  const match = await expectedRevision(request);
  if ("error" in match) return match.error;
  const parsedBody = await boundedJsonBody(request, 128 * 1024);
  const body = parsedBody.ok && parsedBody.value && typeof parsedBody.value === "object"
    && !Array.isArray(parsedBody.value)
    ? parsedBody.value as Record<string, unknown>
    : null;
  if (!body || typeof body.action !== "string") return jsonError("Invalid dashboard action", 400);

  let definition = currentDefinition(dashboard);
  let state = dashboard.state as "draft" | "published" | "archived";
  let ownerMemberId = dashboard.ownerMemberId;
  let operation: "update" | "publish" | "archive" | "restore" | "transfer";

  if (body.action === "update" && Object.keys(body).length === 2) {
    try {
      definition = parseSharedDashboardDefinition(body.definition);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Invalid dashboard definition", 400);
    }
    state = "draft";
    operation = "update";
    if (match.value !== dashboard.revision) {
      if (sameDashboardOutcome(
        dashboard,
        match.value,
        definition,
        state,
        ownerMemberId,
      )) {
        return privateJson({ dashboard: publicDashboard(dashboard) });
      }
      const copy = await commitDashboardCreate({
        organizationId: workspaceId,
        dashboard: {
          id: crypto.randomUUID(),
          connectionId: dashboard.connectionId,
          ...definition,
          title: conflictTitle(definition.title),
        },
        authority: authority(connectionAuthorization),
        operation: "conflict_copy",
        sourceDashboardId: dashboardId,
      });
      if (!copy) return jsonError("Dashboard authority changed. Retry the update.", 409);
      return privateJson({
        error: "Dashboard conflict",
        serverRevision: dashboard.revision,
        conflictCopy: publicDashboard(copy),
      }, { status: 409 });
    }
  } else if (body.action === "publish" && Object.keys(body).length === 1) {
    if (dashboard.state === "archived") {
      return jsonError("Restore an archived dashboard before publishing it", 409);
    }
    state = "published";
    operation = "publish";
  } else if (body.action === "archive" && Object.keys(body).length === 1) {
    state = "archived";
    operation = "archive";
  } else if (
    body.action === "transfer"
    && Object.keys(body).length === 2
    && typeof body.ownerMemberId === "string"
    && isUuid(body.ownerMemberId)
  ) {
    ownerMemberId = body.ownerMemberId;
    operation = "transfer";
  } else if (
    body.action === "restore"
    && Object.keys(body).length === 2
    && typeof body.revision === "number"
    && Number.isSafeInteger(body.revision)
    && body.revision >= 1
  ) {
    const historical = await db.query.workspaceDashboardRevision.findFirst({
      where: and(
        eq(workspaceDashboardRevision.organizationId, workspaceId),
        eq(workspaceDashboardRevision.dashboardId, dashboardId),
        eq(workspaceDashboardRevision.revision, body.revision),
      ),
      columns: { payload: true },
    });
    if (!historical) return jsonError("Dashboard revision not found", 404);
    try {
      const payload = parseDashboardVersionPayload(historical.payload);
      if (payload.connectionId !== dashboard.connectionId || payload.deleted) {
        return jsonError("Dashboard revision cannot be restored", 409);
      }
      definition = payload;
      state = "draft";
    } catch {
      return jsonError("Dashboard revision is invalid", 409);
    }
    operation = "restore";
  } else {
    return jsonError("Invalid dashboard action", 400);
  }

  if (match.value !== dashboard.revision) {
    if (sameDashboardOutcome(
      dashboard,
      match.value,
      definition,
      state,
      ownerMemberId,
    )) {
      return privateJson({ dashboard: publicDashboard(dashboard) });
    }
    return jsonError("Dashboard changed concurrently. Retry the action.", 409);
  }
  const updated = await commitDashboardMutation({
    organizationId: workspaceId,
    dashboardId,
    connectionId: dashboard.connectionId,
    expectedRevision: match.value,
    definition,
    state,
    ownerMemberId,
    authority: authority(connectionAuthorization),
    operation,
  });
  if (!updated) return jsonError("Dashboard authority changed. Retry the action.", 409);
  return privateJson({ dashboard: publicDashboard(updated) });
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, dashboardId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(dashboardId)) {
    return jsonError("Invalid workspace or dashboard id", 400);
  }
  const workspace = await authorizeWorkspace(request, workspaceId, "write");
  if (!workspace.ok) return jsonError(workspace.error, workspace.status);
  const match = await expectedRevision(request);
  if ("error" in match) return match.error;
  const dashboard = await accessibleDashboard(
    workspaceId,
    dashboardId,
    workspace.membership.id,
    true,
    true,
  );
  if (!dashboard) return jsonError("Dashboard not found", 404);
  const connectionAuthorization = await authorizeWorkspaceConnection(
    request,
    workspaceId,
    dashboard.connectionId,
    "use",
  );
  if (!connectionAuthorization.ok) {
    return jsonError(connectionAuthorization.error, connectionAuthorization.status);
  }
  if (!hasWorkspaceCapability(connectionAuthorization.role, "write")) {
    return jsonError("Dashboard deletion requires workspace Editor access", 403);
  }
  if (dashboard.deletedAt) {
    const deletedRevision = match.value + 1;
    if (Number.isSafeInteger(deletedRevision) && dashboard.revision === deletedRevision) {
      return privateJson({ deleted: true, revision: dashboard.revision });
    }
    return jsonError("Dashboard deletion changed concurrently", 409);
  }
  if (!dashboard.ownerMemberId) return jsonError("Dashboard owner is unavailable", 409);
  if (match.value !== dashboard.revision) {
    return jsonError("Dashboard changed concurrently. Retry deletion.", 409);
  }
  const deleted = await commitDashboardMutation({
    organizationId: workspaceId,
    dashboardId,
    connectionId: dashboard.connectionId,
    expectedRevision: match.value,
    definition: currentDefinition(dashboard),
    state: "archived",
    ownerMemberId: dashboard.ownerMemberId,
    authority: authority(connectionAuthorization),
    operation: "delete",
  });
  if (!deleted) return jsonError("Dashboard authority changed. Retry deletion.", 409);
  return privateJson({ deleted: true, revision: deleted.revision });
}
