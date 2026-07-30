// Receipt-only provider import. External provider identifiers are accepted only
// while discovering them; this endpoint consumes a session/member-bound opaque
// receipt through the one-statement import command.
import { env } from "../../../../../../../../lib/env";
import { isUuid, jsonError, mutationAllowed, privateJson } from "../../../../../../../../lib/http";
import { importProviderReceipt } from "../../../../../../../../lib/provider-import-store";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";
import { publicConnection } from "../../../../../../../../lib/workspace-connections";

type RouteContext = { params: Promise<{ workspaceId: string; integrationId: string }> };

function importName(value: unknown) {
  if (value === undefined) return "Managed database";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 120 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, integrationId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(integrationId)) return jsonError("Invalid workspace or integration id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (authorization.role !== "admin" && authorization.role !== "owner") {
    return jsonError("Workspace access denied", 403);
  }
  const body = await request.json().catch(() => null) as {
    connectionId?: unknown;
    receipt?: unknown;
    idempotencyKey?: unknown;
    name?: unknown;
    productionApproved?: unknown;
  } | null;
  const name = importName(body?.name);
  const connectionId = body?.connectionId === null || body?.connectionId === undefined
    ? null
    : body.connectionId;
  if (
    !body || typeof body.receipt !== "string" || !isUuid(body.receipt)
    || (connectionId !== null && (typeof connectionId !== "string" || !isUuid(connectionId)))
    || typeof body.idempotencyKey !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/.test(body.idempotencyKey)
    || typeof body.productionApproved !== "boolean"
    || !name
  ) {
    return jsonError("A discovery receipt, idempotency key, and valid name are required", 400);
  }
  const result = await importProviderReceipt({
    organizationId: workspaceId,
    integrationId,
    receiptId: body.receipt,
    idempotencyKey: body.idempotencyKey,
    connectionId,
    name,
    productionApproved: body.productionApproved,
    authority: {
      sessionId: authorization.session.session.id,
      userId: authorization.session.user.id,
      membershipId: authorization.membership.id,
      role: authorization.role,
    },
  });
  if (result.kind === "idempotency_conflict") {
    return jsonError("Import request conflicts with an existing idempotency key", 409);
  }
  if (result.kind === "resource_conflict") {
    return jsonError("Provider resource is already imported", 409);
  }
  if (result.kind !== "imported") {
    return jsonError("Discovery receipt is invalid, expired, or already used", 409);
  }
  return privateJson({
    connection: publicConnection(result.connection, authorization.role, authorization.accessMode),
  }, { status: connectionId ? 200 : 201 });
}
