// Durable Neon branch-operation boundary. Planning performs no Provider
// mutation; approval revalidates one fresh complete inventory before recording
// the exact decision. Execution owns the later remote-start fence.
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../../../../../../../../lib/db";
import { env } from "../../../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../../lib/http";
import {
  activeProviderIntegration,
  type ActiveProviderIntegration,
  verifiedNeonProjectCredential,
} from "../../../../../../../../../lib/provider-integrations";
import { providerOperationOwnershipMarker } from "../../../../../../../../../lib/provider-operation-marker";
import {
  decideProviderOperation,
  loadProviderOperationPlan,
  recordProviderOperationPlan,
  type ProviderOperationDecision,
} from "../../../../../../../../../lib/provider-operation-store";
import { MAX_PROVIDER_RESULTS } from "../../../../../../../../../lib/providers/adapter-contract";
import {
  buildNeonBranchCreatePlan,
  NeonBranchPlanError,
  parseNeonBranchCreatePlanRequest,
  revalidateNeonBranchCreatePlan,
} from "../../../../../../../../../lib/providers/neon-branch-plan";
import { listNeonBranchInventory } from "../../../../../../../../../lib/providers/neon";
import { parseNeonResource } from "../../../../../../../../../lib/providers/neon-core";
import { ProviderRequestError } from "../../../../../../../../../lib/providers/provider-types";
import { workspaceConnection } from "../../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../../lib/workspace-authorization";
import { canonicalHash } from "../../../../../../../../../lib/workspace-versioning";

type RouteContext = {
  params: Promise<{ workspaceId: string; integrationId: string }>;
};

type OperationBody =
  | Readonly<{ action: "planCreate"; request: unknown }>
  | Readonly<{
    action: "decideCreate";
    operationId: string;
    planHash: string;
    decision: ProviderOperationDecision;
  }>;

export const maxDuration = 60;

function exactOperationBody(value: unknown): OperationBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    body.action === "planCreate"
    && Object.keys(body).length === 2
    && Object.prototype.hasOwnProperty.call(body, "request")
  ) {
    return { action: "planCreate", request: body.request };
  }
  if (
    body.action === "decideCreate"
    && Object.keys(body).length === 4
    && Object.prototype.hasOwnProperty.call(body, "operationId")
    && Object.prototype.hasOwnProperty.call(body, "planHash")
    && Object.prototype.hasOwnProperty.call(body, "decision")
    && typeof body.operationId === "string"
    && isUuid(body.operationId)
    && typeof body.planHash === "string"
    && /^[0-9a-f]{64}$/.test(body.planHash)
    && (body.decision === "approved" || body.decision === "rejected")
  ) {
    return {
      action: "decideCreate",
      operationId: body.operationId,
      planHash: body.planHash,
      decision: body.decision,
    };
  }
  return null;
}

async function livePlanContext(input: {
  workspaceId: string;
  integrationId: string;
  integration: ActiveProviderIntegration;
  projectId: string;
  sourceBranchId: string;
}) {
  const credential = await verifiedNeonProjectCredential(
    input.integration,
    input.projectId,
  );
  const [inventory, connectionRows] = await Promise.all([
    listNeonBranchInventory(credential, input.projectId),
    db.select({
      environment: workspaceConnection.environment,
      resource: workspaceConnection.providerResource,
    }).from(workspaceConnection).where(and(
      eq(workspaceConnection.organizationId, input.workspaceId),
      eq(workspaceConnection.providerIntegrationId, input.integrationId),
      eq(workspaceConnection.credentialMode, "managed"),
      isNull(workspaceConnection.deletedAt),
      isNull(workspaceConnection.revocationPendingAt),
    )).limit(MAX_PROVIDER_RESULTS + 1),
  ]);
  if (connectionRows.length > MAX_PROVIDER_RESULTS) {
    throw new ProviderRequestError(
      "neon",
      "Workspace Neon connection scope is too large to plan safely",
      409,
    );
  }
  let workspaceProductionReference = false;
  for (const row of connectionRows) {
    let resource;
    try {
      resource = parseNeonResource(row.resource);
    } catch {
      throw new ProviderRequestError(
        "neon",
        "Workspace Neon connection target is invalid",
        409,
      );
    }
    if (
      resource.project === input.projectId
      && resource.branch === input.sourceBranchId
      && row.environment === "production"
    ) {
      workspaceProductionReference = true;
    }
  }
  return { inventory, workspaceProductionReference };
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
  const body = parsedBody.ok ? exactOperationBody(parsedBody.value) : null;
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
  const authority = {
    organizationId: workspaceId,
    membershipId: authorization.membership.id,
    userId: authorization.session.user.id,
    sessionId: authorization.session.session.id,
    role: authorization.role,
  };

  try {
    if (body.action === "decideCreate") {
      const operation = await loadProviderOperationPlan({
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: body.operationId,
      });
      if (!operation || operation.planHash !== body.planHash) {
        return jsonError("Neon branch operation plan changed or is unavailable", 409);
      }
      if (body.decision === "approved" && operation.state === "awaiting_approval") {
        const live = await livePlanContext({
          workspaceId,
          integrationId,
          integration,
          projectId: operation.plan.source.projectId,
          sourceBranchId: operation.plan.source.branchId,
        });
        revalidateNeonBranchCreatePlan({
          plan: operation.plan,
          inventory: live.inventory,
          workspaceProductionReference: live.workspaceProductionReference,
          now: new Date(),
        });
      }
      const decided = await decideProviderOperation({
        authority,
        integrationId,
        integrationGeneration: integration.generation,
        operationId: operation.id,
        planHash: operation.planHash,
        ownershipMarker: operation.ownershipMarker,
        decision: body.decision,
        now: new Date(),
      });
      if (!decided) {
        return jsonError("Neon branch approval authority or operation changed", 409);
      }
      return privateJson({
        operation: {
          id: decided.id,
          state: decided.state,
          planHash: operation.planHash,
          decision: decided.decision,
          approvalId: decided.approvalId,
          replayed: decided.replayed,
        },
      });
    }

    const planRequest = parseNeonBranchCreatePlanRequest(body.request);
    const live = await livePlanContext({
      workspaceId,
      integrationId,
      integration,
      projectId: planRequest.projectId,
      sourceBranchId: planRequest.sourceBranchId,
    });
    const operationId = crypto.randomUUID();
    const now = new Date();
    const plan = buildNeonBranchCreatePlan({
      request: planRequest,
      inventory: live.inventory,
      operationId,
      integrationId,
      integrationGeneration: integration.generation,
      workspaceProductionReference: live.workspaceProductionReference,
      now,
    });
    const requestHash = canonicalHash({
      version: 1,
      organizationId: workspaceId,
      integrationId,
      integrationGeneration: integration.generation.toString(),
      requestedByMemberId: authorization.membership.id,
      requestedByUserId: authorization.session.user.id,
      requestedBySessionId: authorization.session.session.id,
      requestedByRole: authorization.role,
      request: planRequest,
      sourceSnapshot: plan.source,
      workspaceProductionReference: live.workspaceProductionReference,
    });
    const planHash = canonicalHash(plan);
    const ownershipMarker = providerOperationOwnershipMarker({
      organizationId: workspaceId,
      integrationId,
      integrationGeneration: integration.generation,
      operationId,
      planHash,
    });
    const recorded = await recordProviderOperationPlan({
      authority,
      integrationId,
      integrationGeneration: integration.generation,
      operationId,
      idempotencyKey: planRequest.idempotencyKey,
      requestHash,
      planHash,
      ownershipMarker,
      plan,
      now,
    });
    if (!recorded) {
      return jsonError("Neon branch plan authority or idempotency key changed", 409);
    }
    return privateJson({
      operation: {
        id: recorded.id,
        state: recorded.state,
        planHash: recorded.planHash,
        planExpiresAt: recorded.planExpiresAt.toISOString(),
        expired: recorded.planExpiresAt.valueOf() <= Date.now(),
        risk: recorded.risk,
        approvalPolicy: recorded.approvalPolicy,
        replayed: recorded.replayed,
        plan: recorded.plan,
      },
    });
  } catch (error) {
    if (error instanceof NeonBranchPlanError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof ProviderRequestError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Neon branch operation request failed", 502);
  }
}
