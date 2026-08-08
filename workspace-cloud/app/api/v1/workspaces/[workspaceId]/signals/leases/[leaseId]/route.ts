import {
  isUuid,
  jsonError,
  privateJson,
} from "../../../../../../../../lib/http";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";
import { signalRunnerLeaseIsActive } from "../../../../../../../../lib/workspace-signal-store";

type RouteContext = { params: Promise<{ workspaceId: string; leaseId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, leaseId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(leaseId)) return jsonError("Invalid signal scope", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const capability = request.headers.get("x-dopedb-signal-lease")?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) {
    return jsonError("Invalid signal lease capability", 401);
  }
  const active = await signalRunnerLeaseIsActive({
    organizationId: workspaceId,
    leaseId,
    leaseCapability: capability,
    authority: {
      sessionId: authorization.session.session.id,
      userId: authorization.session.user.id,
      membershipId: authorization.membership.id,
      role: authorization.role,
    },
  });
  return privateJson({ active });
}
