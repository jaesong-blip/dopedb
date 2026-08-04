// Returns one expiring, secret-free canonical target for the desktop Managed
// Access planner. It is discovery authority only, never mutation or lease authority.
import { isUuid, jsonError, privateJson } from "../../../../../../../../lib/http";
import { loadProviderProvisioningTarget } from "../../../../../../../../lib/provider-provisioning-target";
import { authorizeWorkspaceConnection } from "../../../../../../../../lib/workspace-authorization";

type RouteContext = {
  params: Promise<{ workspaceId: string; connectionId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, connectionId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(connectionId)) {
    return jsonError("Invalid workspace or connection id", 400);
  }
  const authorization = await authorizeWorkspaceConnection(
    request,
    workspaceId,
    connectionId,
    "manage",
  );
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  try {
    const target = await loadProviderProvisioningTarget({
      organizationId: workspaceId,
      connectionId,
    });
    if (!target) return jsonError("Managed Access target is unavailable", 409);
    return privateJson({ target });
  } catch {
    return jsonError("Managed Access target is temporarily unavailable", 500);
  }
}
