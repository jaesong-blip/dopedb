import { env } from "../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../lib/http";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";
import { claimSignalRunnerLease } from "../../../../../../../lib/workspace-signal-store";
import { parseSignalLeaseClaim } from "../../../../../../../lib/workspace-signals";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const body = await boundedJsonBody(request, 8 * 1024);
  if (!body.ok) return jsonError("Invalid signal lease request", 400);
  let claim;
  try {
    claim = parseSignalLeaseClaim(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid signal lease", 400);
  }
  const lease = await claimSignalRunnerLease({
    organizationId: workspaceId,
    claim,
    authority: {
      sessionId: authorization.session.session.id,
      userId: authorization.session.user.id,
      membershipId: authorization.membership.id,
      role: authorization.role,
    },
  });
  if (!lease) return privateJson({ lease: null });
  return privateJson({
    lease: {
      ...lease,
      expiresAt: lease.expiresAt.toISOString(),
      scheduledAt: lease.scheduledAt.toISOString(),
    },
  }, { status: 201 });
}
