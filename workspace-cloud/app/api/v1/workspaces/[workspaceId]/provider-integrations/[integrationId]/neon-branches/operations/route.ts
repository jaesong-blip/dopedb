// Thin HTTP boundary for durable Neon branch operations. The feature-owned
// application service owns plan, approval, execution, and reconciliation order.
import { env } from "@/lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "@/lib/http";
import { activeProviderIntegration } from "@/lib/provider-integrations/integration-repository";
import {
  listNeonBranchOperations,
  runNeonBranchOperation,
  type NeonBranchOperationOutcome,
} from "@/lib/providers/neon-branch-operation-application";
import { parseNeonBranchOperationCommand } from "@/lib/providers/neon-branch-operation-command";
import {
  authorizeWorkspace,
  authorizeWorkspaceConnection,
} from "@/lib/workspace-authorization";

type RouteContext = {
  params: Promise<{ workspaceId: string; integrationId: string }>;
};

export const maxDuration = 60;

function operationResponse(outcome: NeonBranchOperationOutcome) {
  return outcome.ok
    ? privateJson(outcome.body, { status: outcome.status })
    : jsonError(outcome.error, outcome.status);
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, integrationId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(integrationId)) {
    return jsonError("Invalid workspace or integration id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (authorization.role !== "admin" && authorization.role !== "owner") {
    return jsonError("Workspace access denied", 403);
  }
  const integration = await activeProviderIntegration(workspaceId, integrationId);
  if (!integration || integration.provider !== "neon") {
    return jsonError("Neon integration not found", 404);
  }
  return operationResponse(await listNeonBranchOperations({
    workspaceId,
    integrationId,
    integration,
    currentMemberId: authorization.membership.id,
    currentUserId: authorization.session.user.id,
  }));
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, integrationId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(integrationId)) {
    return jsonError("Invalid workspace or integration id", 400);
  }
  const parsedBody = await boundedJsonBody(request, 16 * 1_024);
  const body = parsedBody.ok
    ? parseNeonBranchOperationCommand(parsedBody.value)
    : null;
  if (!body) return jsonError("Invalid Neon branch operation request", 400);

  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (authorization.role !== "admin" && authorization.role !== "owner") {
    return jsonError("Workspace access denied", 403);
  }
  const integration = await activeProviderIntegration(workspaceId, integrationId);
  if (!integration || integration.provider !== "neon") {
    return jsonError("Neon integration not found", 404);
  }

  return operationResponse(await runNeonBranchOperation({
    workspaceId,
    integrationId,
    integration,
    authority: {
      organizationId: workspaceId,
      membershipId: authorization.membership.id,
      userId: authorization.session.user.id,
      sessionId: authorization.session.session.id,
      role: authorization.role,
    },
    body,
    authorizeConnection: async (connectionId) => {
      const connectionAuthorization = await authorizeWorkspaceConnection(
        request,
        workspaceId,
        connectionId,
        "manage",
      );
      return connectionAuthorization.ok
        ? { ok: true }
        : {
          ok: false,
          error: connectionAuthorization.error,
          status: connectionAuthorization.status,
        };
    },
  }));
}
