// Durable planning endpoint for Neon branch creation. It performs no Provider
// mutation: a separately authorized approval and execution transition owns the
// remote-start fence.
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
  verifiedNeonProjectCredential,
} from "../../../../../../../../../lib/provider-integrations";
import { providerOperationOwnershipMarker } from "../../../../../../../../../lib/provider-operation-marker";
import { recordProviderOperationPlan } from "../../../../../../../../../lib/provider-operation-store";
import { MAX_PROVIDER_RESULTS } from "../../../../../../../../../lib/providers/adapter-contract";
import {
  buildNeonBranchCreatePlan,
  NeonBranchPlanError,
  parseNeonBranchCreatePlanRequest,
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

export const maxDuration = 60;

function exactPlanBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 2
    || body.action !== "planCreate"
    || !Object.hasOwn(body, "request")
  ) {
    return null;
  }
  return body.request;
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
  const requestValue = parsedBody.ok ? exactPlanBody(parsedBody.value) : null;
  if (!requestValue) return jsonError("Invalid Neon branch operation request", 400);

  let planRequest;
  try {
    planRequest = parseNeonBranchCreatePlanRequest(requestValue);
  } catch (error) {
    if (error instanceof NeonBranchPlanError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Invalid Neon branch create plan request", 400);
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
  const authority = {
    organizationId: workspaceId,
    membershipId: authorization.membership.id,
    userId: authorization.session.user.id,
    sessionId: authorization.session.session.id,
    role: authorization.role,
  };

  try {
    const credential = await verifiedNeonProjectCredential(
      integration,
      planRequest.projectId,
    );
    const [inventory, connectionRows] = await Promise.all([
      listNeonBranchInventory(credential, planRequest.projectId),
      db.select({
        environment: workspaceConnection.environment,
        resource: workspaceConnection.providerResource,
      }).from(workspaceConnection).where(and(
        eq(workspaceConnection.organizationId, workspaceId),
        eq(workspaceConnection.providerIntegrationId, integrationId),
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
        resource.project === planRequest.projectId
        && resource.branch === planRequest.sourceBranchId
        && row.environment === "production"
      ) {
        workspaceProductionReference = true;
      }
    }

    const operationId = crypto.randomUUID();
    const now = new Date();
    const plan = buildNeonBranchCreatePlan({
      request: planRequest,
      inventory,
      operationId,
      integrationId,
      integrationGeneration: integration.generation,
      workspaceProductionReference,
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
      sourceSnapshot: {
        branchId: plan.source.branchId,
        currentState: plan.source.currentState,
        pendingState: plan.source.pendingState,
        stateChangedAt: plan.source.stateChangedAt,
        updatedAt: plan.source.updatedAt,
        default: plan.source.default,
        protected: plan.source.protected,
        restrictedActions: plan.source.restrictedActions,
        workspaceProductionReference,
      },
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
    return jsonError("Neon branch operation planning failed", 502);
  }
}
