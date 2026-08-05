// Server-side workspace authorization. Every resource request resolves the session
// and membership from the database and fails closed; client role claims are ignored.
import "server-only";

import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "./db";
import { authoritativeSession } from "./authoritative-session";
import {
  member,
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceProfile,
} from "./schema";
import {
  accessModeForRole,
  accessModeForConnectionGrant,
  hasWorkspaceCapability,
  isWorkspaceRole,
  type WorkspaceCapability,
  type WorkspaceConnectionCapability,
} from "./workspace-permissions";

export type { WorkspaceRoleName } from "./workspace-permissions";
export type { WorkspaceConnectionCapability } from "./workspace-permissions";

const connectionCapabilityRank: Record<WorkspaceConnectionCapability, number> = {
  view: 0,
  use: 1,
  manage: 2,
};

export async function authorizeWorkspace(
  request: Request,
  organizationId: string,
  capability: WorkspaceCapability,
) {
  const session = await authoritativeSession(request);
  if (!session) return { ok: false as const, status: 401, error: "Unauthorized" };

  const [authority] = await db.select({
    membership: member,
    lifecycleState: workspaceProfile.lifecycleState,
  }).from(member).innerJoin(
    workspaceProfile,
    eq(workspaceProfile.organizationId, member.organizationId),
  ).where(and(
      eq(member.organizationId, organizationId),
      eq(member.userId, session.user.id),
      isNull(member.revocationPendingAt),
    )).limit(1);
  const membership = authority?.membership;
  if (
    !membership
    || membership.revocationPendingAt
    || !isWorkspaceRole(membership.role)
    || authority.lifecycleState !== "active"
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

// Deletion scheduling suspends every ordinary membership gate. Only the exact
// Owner whose pending marker matches the profile deletion timestamp may inspect
// or cancel that lifecycle; an unrelated member-removal claim stays denied.
export async function authorizeWorkspaceLifecycle(
  request: Request,
  organizationId: string,
) {
  const session = await authoritativeSession(request);
  if (!session) return { ok: false as const, status: 401, error: "Unauthorized" };
  const [row] = await db.select({
    membership: member,
    lifecycleState: workspaceProfile.lifecycleState,
  }).from(member).innerJoin(
    workspaceProfile,
    eq(workspaceProfile.organizationId, member.organizationId),
  ).where(and(
    eq(member.organizationId, organizationId),
    eq(member.userId, session.user.id),
    eq(member.role, "owner"),
    isNull(member.revocationClaimId),
    or(
      and(
        eq(workspaceProfile.lifecycleState, "active"),
        isNull(member.revocationPendingAt),
      ),
      and(
        eq(workspaceProfile.lifecycleState, "deletion_pending"),
        eq(member.revocationPendingAt, workspaceProfile.deletionRequestedAt),
      ),
    ),
  )).limit(1);
  if (!row) {
    return { ok: false as const, status: 403, error: "Workspace owner access is required" };
  }
  return {
    ok: true as const,
    session,
    membership: row.membership,
    lifecycleState: row.lifecycleState,
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
    accessMode: accessModeForConnectionGrant(workspace.role, capability),
  };
}
