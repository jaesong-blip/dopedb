// One authorized snapshot prevents the Desktop Explorer from fetching the same
// Project inventory once for the tree and again while projecting its sources.
import { isUuid, jsonError, privateJson } from "@/lib/http";
import {
  listKnowledgeProjects,
  listKnowledgeSources,
} from "@/lib/knowledge/inventory";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const [projects, sources] = await Promise.all([
    listKnowledgeProjects(workspaceId),
    listKnowledgeSources(workspaceId),
  ]);
  return privateJson({ projects, sources });
}
