// Claim the next due live Article refresh. The response carries a short one-run
// capability and immutable definition; credentials remain on Desktop.
import { env } from "../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../lib/http";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";
import { claimAnalysisRefreshLease } from "../../../../../../../lib/workspace-analysis-runner-store";
import { parseAnalysisLeaseClaim } from "../../../../../../../lib/workspace-analysis-runs";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const body = await boundedJsonBody(request, 8 * 1024);
  if (!body.ok) return jsonError("Invalid Analysis refresh lease request", 400);
  let claim;
  try {
    claim = parseAnalysisLeaseClaim(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid Analysis refresh lease", 400);
  }
  const lease = await claimAnalysisRefreshLease({
    organizationId: workspaceId,
    claim,
    authority: {
      sessionId: authorization.session.session.id,
      userId: authorization.session.user.id,
      membershipId: authorization.membership.id,
      role: authorization.role,
    },
  });
  return privateJson({
    lease: lease ? {
      ...lease,
      scheduledAt: lease.scheduledAt.toISOString(),
      expiresAt: lease.expiresAt.toISOString(),
    } : null,
  });
}
