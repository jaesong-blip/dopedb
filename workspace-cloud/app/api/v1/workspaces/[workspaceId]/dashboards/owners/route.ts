// Minimal ownership candidates for dashboard collaborators. Unlike the member
// administration endpoint, this never exposes invitations or role-management
// commands and is available to current Editors as well as workspace managers.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../../../../../../../lib/db";
import { isUuid, jsonError, privateJson } from "../../../../../../../lib/http";
import { member, user } from "../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "write");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const owners = await db.select({
    id: member.id,
    userId: member.userId,
    name: user.name,
    email: user.email,
    role: member.role,
  }).from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(and(
      eq(member.organizationId, workspaceId),
      inArray(member.role, ["editor", "admin", "owner"]),
      isNull(member.revocationPendingAt),
      isNull(member.revocationClaimId),
    ))
    .orderBy(asc(user.name), asc(member.id));
  return privateJson({ workspaceId, owners });
}
