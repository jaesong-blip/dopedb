// Server-side workspace authorization. Every resource request resolves the session
// and membership from the database and fails closed; client role claims are ignored.
import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { authoritativeSession } from "./authoritative-session";
import { member, workspaceConnection, workspaceConnectionGrant } from "./schema";
import {
  accessModeForRole,
  hasWorkspaceCapability,
  isWorkspaceRole,
  type WorkspaceCapability,
} from "./workspace-permissions";

export type { WorkspaceRoleName } from "./workspace-permissions";

export type WorkspaceConnectionCapability = "view" | "use" | "manage";

const connectionCapabilityRank: Record<WorkspaceConnectionCapability, number> = {
  view: 0,
  use: 1,
  manage: 2,
};

function connectionAccessMode(capability: WorkspaceConnectionCapability) {
  if (capability === "manage") return "manage" as const;
  if (capability === "use") return "read" as const;
  return "view" as const;
}

export async function authorizeWorkspace(
  request: Request,
  organizationId: string,
  capability: WorkspaceCapability,
) {
  const session = await authoritativeSession(request);
  if (!session) return { ok: false as const, status: 401, error: "Unauthorized" };

  const membership = await db.query.member.findFirst({
    where: and(
      eq(member.organizationId, organizationId),
      eq(member.userId, session.user.id),
      isNull(member.revocationPendingAt),
    ),
  });
  if (
    !membership
    || membership.revocationPendingAt
    || !isWorkspaceRole(membership.role)
  ) {
    return { ok: false as const, status: 403, error: "Workspace access denied" };
  }
  if (!hasWorkspaceCapability(membership.role, capability)) {
    return { ok: false as const, status: 403, error: "Insufficient workspace permission" };
  }
  return {
    ok: true as const,
    session,
    membership,
    role: membership.role,
    accessMode: accessModeForRole(membership.role),
  };
}

/**
 * Authorizes a target-database template separately from the workspace role.
 * A known UUID is joined through the tenant-scoped grant and non-deleted
 * connection, so membership alone can never turn into database access.
 */
export async function authorizeWorkspaceConnection(
  request: Request,
  organizationId: string,
  connectionId: string,
  required: WorkspaceConnectionCapability,
) {
  const workspace = await authorizeWorkspace(request, organizationId, "view");
  if (!workspace.ok) return workspace;
  const [grant] = await db.select({ capability: workspaceConnectionGrant.capability })
    .from(workspaceConnectionGrant)
    .innerJoin(
      workspaceConnection,
      and(
        eq(workspaceConnection.organizationId, workspaceConnectionGrant.organizationId),
        eq(workspaceConnection.id, workspaceConnectionGrant.connectionId),
      ),
    )
    .where(and(
      eq(workspaceConnectionGrant.organizationId, organizationId),
      eq(workspaceConnectionGrant.connectionId, connectionId),
      eq(workspaceConnectionGrant.memberId, workspace.membership.id),
      isNull(workspaceConnection.deletedAt),
      isNull(workspaceConnection.revocationPendingAt),
    ))
    .limit(1);
  const capability = grant?.capability as WorkspaceConnectionCapability | undefined;
  if (!capability || connectionCapabilityRank[capability] < connectionCapabilityRank[required]) {
    return { ok: false as const, status: 403, error: "Connection grant denied" };
  }
  return {
    ...workspace,
    ok: true as const,
    connectionCapability: capability,
    accessMode: connectionAccessMode(capability),
  };
}
