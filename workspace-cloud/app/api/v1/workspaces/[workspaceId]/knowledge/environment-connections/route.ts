// Workspace-wide Environment bindings are loaded as one bounded snapshot. The
// response stays tenant-scoped and secret-free while avoiding one request per tree row.
import { isUuid, jsonError, privateJson } from "@/lib/http";
import { listKnowledgeEnvironmentConnections } from "@/lib/knowledge/inventory";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const bindings = await listKnowledgeEnvironmentConnections(workspaceId);
  if (!bindings) {
    return jsonError("Environment connection inventory is too large", 503);
  }
  return privateJson({ bindings });
}
