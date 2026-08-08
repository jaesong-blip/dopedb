import { env } from "../../../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../../lib/http";
import { authorizeWorkspace } from "../../../../../../../../../lib/workspace-authorization";
import { commitSignalEvaluationReceipt } from "../../../../../../../../../lib/workspace-signal-store";
import { parseSignalEvaluationReceipt } from "../../../../../../../../../lib/workspace-signals";

type RouteContext = { params: Promise<{ workspaceId: string; leaseId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, leaseId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(leaseId)) return jsonError("Invalid signal scope", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const capability = request.headers.get("x-dopedb-signal-lease")?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) {
    return jsonError("Invalid signal lease capability", 401);
  }
  const body = await boundedJsonBody(request, 64 * 1024);
  if (!body.ok) return jsonError("Invalid signal receipt request", 400);
  let receipt;
  try {
    receipt = parseSignalEvaluationReceipt(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid signal receipt", 400);
  }
  const stored = await commitSignalEvaluationReceipt({
    organizationId: workspaceId,
    leaseId,
    leaseCapability: capability,
    receipt,
    authority: {
      sessionId: authorization.session.session.id,
      userId: authorization.session.user.id,
      membershipId: authorization.membership.id,
      role: authorization.role,
    },
  });
  if (!stored) {
    return jsonError(
      "Signal lease expired, was already consumed, or its exact authority changed",
      409,
    );
  }
  return privateJson({ receipt: stored }, { status: 201 });
}
