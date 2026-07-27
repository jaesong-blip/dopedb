// Read-only, redacted authority projection for member-local provider credentials.
import { isUuid, jsonError, privateJson } from "../../../../../../../lib/http";
import { listLocalProviderAuthority } from "../../../../../../../lib/provider-local-authority";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);

  // A fresh database-backed viewer authorization is required even though this
  // projection has no secret material: it is still tenant-scoped identity data.
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);

  try {
    const integrations = await listLocalProviderAuthority(workspaceId);
    return privateJson({ integrations });
  } catch {
    // Database and malformed-row details can contain provider-owned metadata.
    return jsonError("Provider authority is temporarily unavailable", 500);
  }
}
