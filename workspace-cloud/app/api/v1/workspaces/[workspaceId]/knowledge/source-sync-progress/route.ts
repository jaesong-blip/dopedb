import { isUuid, jsonError, privateJson } from "@/lib/http";
import {
  listKnowledgeSyncProgress,
  MAX_ACTIVE_SYNC_PROGRESS_ROWS,
} from "@/lib/knowledge/source-sync-progress";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);

  const progress = await listKnowledgeSyncProgress(workspaceId);
  if (progress.length > MAX_ACTIVE_SYNC_PROGRESS_ROWS) {
    return jsonError("Knowledge sync inventory is too large", 503);
  }
  return privateJson({ progress });
}
