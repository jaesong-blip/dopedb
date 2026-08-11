// Minimal Analysis Article collaborator directory. It deliberately omits email,
// invitation, and account identifiers; editors need only stable member identity,
// display name, role, and whether a member may own an Article.
import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "../../../../../../../lib/db";
import { isUuid, jsonError, privateJson } from "../../../../../../../lib/http";
import { member, user } from "../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const members = await db.select({
    id: member.id,
    name: user.name,
    role: member.role,
  }).from(member).innerJoin(user, eq(user.id, member.userId)).where(and(
    eq(member.organizationId, workspaceId),
    isNull(member.revocationPendingAt),
    isNull(member.revocationClaimId),
  )).orderBy(asc(user.name));
  return privateJson({
    workspaceId,
    currentMemberId: authorization.membership.id,
    currentRole: authorization.role,
    members: members.map((candidate) => ({
      ...candidate,
      canOwnAnalysis: ["editor", "admin", "owner"].includes(candidate.role),
    })),
  });
}
