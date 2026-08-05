// Unresolved connection conflicts are visible only to members holding the
// connection's explicit manage grant. Payloads are immutable, secret-free
// connection templates; credentials never enter this response.
import { isUuid, jsonError, privateJson } from "../../../../../../../lib/http";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";
import { listConnectionConflicts } from "../../../../../../../lib/workspace-versioning-store";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  try {
    const conflicts = await listConnectionConflicts({
      organizationId: workspaceId,
      membershipId: authorization.membership.id,
    });
    return privateJson({ conflicts });
  } catch {
    return jsonError("Connection conflict history is invalid", 500);
  }
}
