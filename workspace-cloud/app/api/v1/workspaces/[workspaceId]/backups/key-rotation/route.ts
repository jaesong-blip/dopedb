import { env } from "../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../lib/http";
import { authorizeWorkspace } from "../../../../../../../lib/workspace-authorization";
import { createWorkspaceKmsSession } from "../../../../../../../lib/workspace-data-key";
import {
  advanceWorkspaceDataKeyRotation,
  beginOrClaimWorkspaceDataKeyRotation,
  workspaceDataKeyRotationStatus,
} from "../../../../../../../lib/workspace-data-key-rotation";
import { WorkspaceKmsError } from "../../../../../../../lib/workspace-kms-core";
import { logWorkspaceKmsFailure } from "../../../../../../../lib/workspace-server-log";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export const maxDuration = 60;

async function ownerAuthorization(request: Request, workspaceId: string) {
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return authorization;
  return authorization.role === "owner"
    ? authorization
    : { ok: false as const, error: "Workspace owner access is required", status: 403 };
}

function kmsErrorResponse(error: unknown, operation: "rotate") {
  if (error instanceof WorkspaceKmsError) {
    logWorkspaceKmsFailure({ operation, kind: error.kind, status: error.status });
    return jsonError(
      error.kind === "integrity"
        ? "Workspace backup key integrity validation failed"
        : error.kind === "configuration" || error.kind === "oidc"
          ? "Workspace key service is not configured"
          : "Workspace key service is unavailable",
      error.kind === "integrity" ? 409 : 503,
    );
  }
  logWorkspaceKmsFailure({ operation, kind: "unexpected", status: 0 });
  return jsonError("Workspace key rotation is unavailable", 503);
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await ownerAuthorization(request, workspaceId);
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  return privateJson(await workspaceDataKeyRotationStatus(workspaceId));
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const body = await boundedJsonBody(request, 128);
  if (!body.ok) {
    return jsonError(
      body.reason === "too_large" ? "Key rotation request is too large" : "Invalid key rotation request",
      body.reason === "too_large" ? 413 : 400,
    );
  }
  let requestId: string;
  try {
    const parsed = body.value as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1
      || typeof parsed.requestId !== "string"
      || !isUuid(parsed.requestId)) {
      return jsonError("Key rotation request id is required", 400);
    }
    requestId = parsed.requestId;
  } catch {
    return jsonError("Key rotation request must be valid JSON", 400);
  }
  const authorization = await ownerAuthorization(request, workspaceId);
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const authority = {
    sessionId: authorization.session.session.id,
    userId: authorization.session.user.id,
    membershipId: authorization.membership.id,
  };
  try {
    const kms = await createWorkspaceKmsSession(request);
    const claimed = await beginOrClaimWorkspaceDataKeyRotation({
      organizationId: workspaceId,
      authority,
      kms,
      idempotencyKey: requestId,
    });
    if (claimed.replayed) {
      return privateJson({
        ...await workspaceDataKeyRotationStatus(workspaceId),
        busy: false,
        replayed: true,
      });
    }
    if (!claimed.claim) {
      return privateJson({
        ...await workspaceDataKeyRotationStatus(workspaceId),
        busy: true,
      }, { status: 202 });
    }
    const advanced = await advanceWorkspaceDataKeyRotation({
      organizationId: workspaceId,
      authority,
      kms,
      claim: claimed.claim,
    });
    return privateJson({
      ...await workspaceDataKeyRotationStatus(workspaceId),
      busy: false,
      advanced,
    }, { status: advanced.status === "completed" ? 201 : 202 });
  } catch (error) {
    return kmsErrorResponse(error, "rotate");
  }
}
