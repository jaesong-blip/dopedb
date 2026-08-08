import { env } from "../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../lib/http";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";
import { hasWorkspaceCapability } from "../../../../../../../lib/workspace-permissions";
import { commitSignalRuleMutation } from "../../../../../../../lib/workspace-signal-store";
import { parseSignalRuleMutation } from "../../../../../../../lib/workspace-signals";
import { parseExpectedRevision } from "../../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ workspaceId: string; ruleId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, ruleId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(ruleId)) return jsonError("Invalid signal scope", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Signal commands require workspace Editor access", 403);
  }
  let expectedRevision: number | null;
  try {
    expectedRevision = parseExpectedRevision(request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid If-Match", 400);
  }
  if (expectedRevision === null || expectedRevision < 1) {
    return jsonError("Signal commands require the current If-Match revision", 409);
  }
  const body = await boundedJsonBody(request, 8 * 1024);
  if (!body.ok) return jsonError("Invalid signal command request", 400);
  let mutation;
  try {
    mutation = parseSignalRuleMutation(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid signal command", 400);
  }
  const rule = await commitSignalRuleMutation({
    organizationId: workspaceId,
    ruleId,
    expectedRevision,
    mutation,
    authority: {
      sessionId: authorization.session.session.id,
      userId: authorization.session.user.id,
      membershipId: authorization.membership.id,
      role: authorization.role,
    },
  });
  if (!rule) return jsonError("Signal rule changed or the command is not authorized", 409);
  return privateJson({
    rule: { ...rule, nextEvaluationAt: rule.nextEvaluationAt.toISOString() },
  });
}
