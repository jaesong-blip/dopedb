// Records one immutable human decision after the existing connection mutation
// path has safely applied (or intentionally retained) a conflict version.
import { and, eq } from "drizzle-orm";

import { db } from "../../../../../../../../lib/db";
import { env } from "../../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../lib/http";
import {
  workspaceConnectionGrant,
  workspaceResourceConflict,
} from "../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";
import {
  resolveConnectionConflict,
  type ConnectionConflictResolution,
  type MutationAuthority,
} from "../../../../../../../../lib/workspace-versioning-store";

type RouteContext = {
  params: Promise<{ workspaceId: string; conflictId: string }>;
};

function mutationAuthority(authorization: {
  role: string;
  session: { session: { id: string }; user: { id: string } };
  membership: { id: string };
}): MutationAuthority {
  return {
    sessionId: authorization.session.session.id,
    userId: authorization.session.user.id,
    membershipId: authorization.membership.id,
    role: authorization.role,
  };
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, conflictId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(conflictId)) {
    return jsonError("Invalid workspace or conflict id", 400);
  }
  const workspaceAuthorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!workspaceAuthorization.ok) {
    return jsonError(workspaceAuthorization.error, workspaceAuthorization.status);
  }
  const [conflict] = await db.select({ resourceId: workspaceResourceConflict.resourceId })
    .from(workspaceResourceConflict)
    .innerJoin(
      workspaceConnectionGrant,
      and(
        eq(workspaceConnectionGrant.organizationId, workspaceResourceConflict.organizationId),
        eq(workspaceConnectionGrant.connectionId, workspaceResourceConflict.resourceId),
        eq(workspaceConnectionGrant.memberId, workspaceAuthorization.membership.id),
        eq(workspaceConnectionGrant.capability, "manage"),
      ),
    )
    .where(and(
      eq(workspaceResourceConflict.organizationId, workspaceId),
      eq(workspaceResourceConflict.id, conflictId),
      eq(workspaceResourceConflict.resourceType, "connection"),
    ))
    .limit(1);
  if (!conflict) return jsonError("Connection conflict not found", 404);
  const body = await boundedJsonBody(request, 256);
  if (!body.ok || !body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return jsonError("Connection conflict decision is invalid", 400);
  }
  const resolution = (body.value as { resolution?: unknown }).resolution;
  if (!["server", "candidate", "dismissed"].includes(String(resolution))) {
    return jsonError("Connection conflict decision is invalid", 400);
  }
  const requested = resolution as ConnectionConflictResolution;
  const resolved = await resolveConnectionConflict({
    organizationId: workspaceId,
    conflictId,
    resolution: requested,
    authority: mutationAuthority(workspaceAuthorization),
  });
  if (!resolved) {
    return jsonError("Connection changed again. Review the current revision.", 409);
  }
  if (resolved.resolution !== requested) {
    return jsonError("Connection conflict was already resolved differently", 409);
  }
  return privateJson({
    resolution: resolved.resolution,
    replayed: !resolved.created,
  });
}
