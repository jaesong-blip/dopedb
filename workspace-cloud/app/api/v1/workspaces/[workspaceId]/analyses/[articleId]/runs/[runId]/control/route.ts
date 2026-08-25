// Minimal execution-control projection for Desktop. A running query needs to
// observe cancellation and authority revocation, but not receipts or Article data.
import { isUuid, jsonError, privateJson } from "@/lib/http";
import { authorizeWorkspace } from "@/lib/workspace-authorization";
import {
  analysisRunnerCapabilityHeader,
  hashAnalysisRunnerCapability,
  isAnalysisDesktopBearerRequest,
  parseAnalysisRunnerCapability,
} from "@/lib/workspace-analysis-runner-capability";
import {
  getAnalysisRunControl,
} from "@/lib/workspace-analysis-run-store";
import { hashAnalysisLeaseCapability } from "@/lib/workspace-analysis-runner-store";

type RouteContext = {
  params: Promise<{ workspaceId: string; articleId: string; runId: string }>;
};

function leaseCapability(request: Request) {
  const value = request.headers.get("x-dopedb-analysis-capability")?.trim() ?? "";
  return value === "" ? null : (/^[0-9a-f]{64}$/.test(value) ? value : undefined);
}

export async function GET(request: Request, context: RouteContext) {
  if (!isAnalysisDesktopBearerRequest(request)) {
    return jsonError("Analysis run control requires a Desktop bearer session", 401);
  }
  const { workspaceId, articleId, runId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(runId)) {
    return jsonError("Invalid Analysis Article run scope", 400);
  }
  const runnerCapability = parseAnalysisRunnerCapability(request);
  if (!runnerCapability) {
    return jsonError(
      "Invalid Analysis runner capability",
      request.headers.has(analysisRunnerCapabilityHeader) ? 403 : 428,
    );
  }
  const lease = leaseCapability(request);
  if (lease === undefined) return jsonError("Invalid Analysis lease capability", 403);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const control = await getAnalysisRunControl({
    organizationId: workspaceId,
    articleId,
    runId,
    membershipId: authorization.membership.id,
    role: authorization.role,
    runnerCapabilityHash: hashAnalysisRunnerCapability(runnerCapability),
    leaseCapabilityHash: lease ? hashAnalysisLeaseCapability(lease) : null,
  });
  if (!control) return jsonError("Analysis Article run not found", 404);
  return privateJson({ control });
}
