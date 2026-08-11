// Cooperative cancellation: the control plane records intent and the exact
// Desktop runner observes it through the run status before completing as
// cancelled. It never pretends that a remote database operation stopped first.
import { env } from "../../../../../../../../../../lib/env";
import { isUuid, jsonError, mutationAllowed, privateJson } from "../../../../../../../../../../lib/http";
import { authorizeWorkspace } from "../../../../../../../../../../lib/workspace-authorization";
import {
  requestAnalysisRunCancellation,
  type AnalysisRunAuthority,
} from "../../../../../../../../../../lib/workspace-analysis-run-store";

type RouteContext = {
  params: Promise<{ workspaceId: string; articleId: string; runId: string }>;
};

function authority(authorization: {
  role: string;
  session: { session: { id: string }; user: { id: string } };
  membership: { id: string };
}): AnalysisRunAuthority {
  return {
    sessionId: authorization.session.session.id,
    userId: authorization.session.user.id,
    membershipId: authorization.membership.id,
    role: authorization.role,
  };
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, articleId, runId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(articleId) || !isUuid(runId)) {
    return jsonError("Invalid Analysis Article run scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const cancelled = await requestAnalysisRunCancellation({
    organizationId: workspaceId,
    articleId,
    runId,
    authority: authority(authorization),
  });
  if (!cancelled) {
    return jsonError("Analysis Article run is terminal or cannot be cancelled by this member", 409);
  }
  return privateJson({ run: cancelled });
}
