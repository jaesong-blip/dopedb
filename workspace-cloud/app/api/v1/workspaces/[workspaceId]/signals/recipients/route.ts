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
  const recipients = await db.select({
    id: member.id,
    name: user.name,
    email: user.email,
    role: member.role,
  }).from(member).innerJoin(user, eq(user.id, member.userId)).where(and(
    eq(member.organizationId, workspaceId),
    isNull(member.revocationPendingAt),
    isNull(member.revocationClaimId),
  )).orderBy(asc(user.name), asc(member.id));
  return privateJson({ workspaceId, recipients });
}
