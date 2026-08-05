// Workspace dashboard collection. Only definitions cross this boundary; every
// member executes them locally through their own connection authority.
import { and, desc, eq, isNull } from "drizzle-orm";

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
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceDashboard,
} from "../../../../../../lib/schema";
import { authorizeWorkspace, authorizeWorkspaceConnection } from "../../../../../../lib/workspace-authorization";
import {
  commitDashboardCreate,
  type DashboardMutationAuthority,
} from "../../../../../../lib/workspace-dashboard-store";
import {
  parseSharedDashboardCreate,
  publicDashboard,
} from "../../../../../../lib/workspace-dashboards";
import { hasWorkspaceCapability } from "../../../../../../lib/workspace-permissions";
import { canonicalHash, parseExpectedRevision } from "../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ workspaceId: string }> };

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

function uniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: unknown; cause?: { code?: unknown } };
  return row.code === "23505" || row.cause?.code === "23505";
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const rows = await db.select({ dashboard: workspaceDashboard })
    .from(workspaceDashboard)
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
        isNull(workspaceConnection.revocationPendingAt),
      ),
    )
    .where(and(
      eq(workspaceDashboard.organizationId, workspaceId),
      isNull(workspaceDashboard.deletedAt),
      hasWorkspaceCapability(authorization.role, "write")
        ? undefined
        : eq(workspaceDashboard.state, "published"),
    ))
    .orderBy(desc(workspaceDashboard.updatedAt), desc(workspaceDashboard.id));
  return privateJson({
    workspaceId,
    dashboards: rows.map(({ dashboard }) => publicDashboard(dashboard)),
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  let expectedRevision: number | null;
  try {
    expectedRevision = parseExpectedRevision(request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid If-Match", 400);
  }
  if (expectedRevision === null) return jsonError("If-Match is required", 428);
  if (expectedRevision !== 0) return jsonError("New dashboards require If-Match: \"0\"", 409);
  const body = await boundedJsonBody(request, 128 * 1024);
  if (!body.ok) return jsonError("Invalid dashboard request", 400);
  let input;
  try {
    input = parseSharedDashboardCreate(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid dashboard", 400);
  }
  const authorization = await authorizeWorkspaceConnection(
    request,
    workspaceId,
    input.connectionId,
    "use",
  );
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Dashboard editing requires workspace Editor access", 403);
  }
  try {
    const dashboard = await commitDashboardCreate({
      organizationId: workspaceId,
      dashboard: input,
      authority: authority(authorization),
    });
    if (!dashboard) return jsonError("Dashboard authority changed. Retry creation.", 409);
    return privateJson({ dashboard: publicDashboard(dashboard) }, { status: 201 });
  } catch (error) {
    if (uniqueViolation(error)) {
      // A lost response after a successful create must be replay-safe. Return the
      // original row only while it is still the exact first revision owned by this
      // member; a reused UUID or any intervening edit remains a real conflict.
      const existing = await db.query.workspaceDashboard.findFirst({
        where: and(
          eq(workspaceDashboard.organizationId, workspaceId),
          eq(workspaceDashboard.id, input.id),
          isNull(workspaceDashboard.deletedAt),
        ),
      });
      if (
        existing
        && existing.connectionId === input.connectionId
        && existing.ownerMemberId === authorization.membership.id
        && existing.revision === 1
        && existing.state === "draft"
        && canonicalHash({
          title: existing.title,
          description: existing.description,
          sql: existing.sql,
          visualization: existing.visualization,
        }) === canonicalHash({
          title: input.title,
          description: input.description,
          sql: input.sql,
          visualization: input.visualization,
        })
      ) {
        return privateJson({ dashboard: publicDashboard(existing) });
      }
      return jsonError("Dashboard already exists", 409);
    }
    throw error;
  }
}
