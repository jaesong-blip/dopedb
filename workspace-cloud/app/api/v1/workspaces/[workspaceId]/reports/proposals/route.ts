// Agent proposals can create complete drafts only. This endpoint exposes no
// publish, replace, archive, transfer, or delete command.
import { isUuid, jsonError } from "../../../../../../../lib/http";
import { createSharedReport } from "../../../../../../../lib/workspace-report-http";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  return createSharedReport(request, workspaceId, "agent_proposal");
}
