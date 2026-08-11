import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import {
  boundedJsonBody,
  isSafeDisplayText,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "@/lib/http";
import {
  knowledgeEnvironmentConnection,
  knowledgeProjectEnvironment,
  workspaceConnection,
} from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = {
  params: Promise<{ workspaceId: string; environmentId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, environmentId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(environmentId)) {
    return jsonError("Invalid Environment scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const bindings = await db.select({
    id: knowledgeEnvironmentConnection.id,
    projectEnvironmentId: knowledgeEnvironmentConnection.projectEnvironmentId,
    environmentRevision: knowledgeEnvironmentConnection.environmentRevision,
    connectionId: knowledgeEnvironmentConnection.connectionId,
    connectionRevision: knowledgeEnvironmentConnection.connectionRevision,
    currentConnectionRevision: workspaceConnection.revision,
    connectionName: workspaceConnection.name,
    role: knowledgeEnvironmentConnection.role,
    alias: knowledgeEnvironmentConnection.alias,
  }).from(knowledgeEnvironmentConnection).innerJoin(
    workspaceConnection,
    and(
      eq(workspaceConnection.organizationId, knowledgeEnvironmentConnection.organizationId),
      eq(workspaceConnection.id, knowledgeEnvironmentConnection.connectionId),
      isNull(workspaceConnection.deletedAt),
    ),
  ).where(and(
    eq(knowledgeEnvironmentConnection.organizationId, workspaceId),
    eq(knowledgeEnvironmentConnection.projectEnvironmentId, environmentId),
    isNull(knowledgeEnvironmentConnection.revokedAt),
  ));
  return privateJson({
    bindings: bindings.map((binding) => ({
      ...binding,
      stale: binding.connectionRevision !== binding.currentConnectionRevision,
    })),
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, environmentId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(environmentId)) {
    return jsonError("Invalid Environment scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const parsed = await boundedJsonBody(request, 8 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (
    !body
    || typeof body.bindingId !== "string"
    || !isUuid(body.bindingId)
    || typeof body.connectionId !== "string"
    || !isUuid(body.connectionId)
    || typeof body.role !== "string"
    || !isSafeDisplayText(body.role.trim(), 64)
    || typeof body.alias !== "string"
    || !isSafeDisplayText(body.alias.trim(), 128)
  ) return jsonError("Invalid Environment connection binding", 400);

  const [scope] = await db.select({
    environmentRevision: knowledgeProjectEnvironment.revision,
    connectionRevision: workspaceConnection.revision,
    connectionName: workspaceConnection.name,
  }).from(knowledgeProjectEnvironment).innerJoin(
    workspaceConnection,
    and(
      eq(workspaceConnection.organizationId, knowledgeProjectEnvironment.organizationId),
      eq(workspaceConnection.id, body.connectionId),
      isNull(workspaceConnection.deletedAt),
    ),
  ).where(and(
    eq(knowledgeProjectEnvironment.organizationId, workspaceId),
    eq(knowledgeProjectEnvironment.id, environmentId),
  )).limit(1);
  if (!scope) return jsonError("Environment or connection not found", 404);

  const [existing] = await db.select({ id: knowledgeEnvironmentConnection.id })
    .from(knowledgeEnvironmentConnection).where(and(
      eq(knowledgeEnvironmentConnection.organizationId, workspaceId),
      eq(knowledgeEnvironmentConnection.projectEnvironmentId, environmentId),
      eq(knowledgeEnvironmentConnection.connectionId, body.connectionId),
      isNull(knowledgeEnvironmentConnection.revokedAt),
    )).limit(1);
  const values = {
    environmentRevision: scope.environmentRevision,
    connectionRevision: scope.connectionRevision,
    role: body.role.trim(),
    alias: body.alias.trim(),
  };
  const [binding] = existing
    ? await db.update(knowledgeEnvironmentConnection).set(values).where(and(
        eq(knowledgeEnvironmentConnection.organizationId, workspaceId),
        eq(knowledgeEnvironmentConnection.id, existing.id),
        isNull(knowledgeEnvironmentConnection.revokedAt),
      )).returning({
        id: knowledgeEnvironmentConnection.id,
        projectEnvironmentId: knowledgeEnvironmentConnection.projectEnvironmentId,
        environmentRevision: knowledgeEnvironmentConnection.environmentRevision,
        connectionId: knowledgeEnvironmentConnection.connectionId,
        connectionRevision: knowledgeEnvironmentConnection.connectionRevision,
        role: knowledgeEnvironmentConnection.role,
        alias: knowledgeEnvironmentConnection.alias,
      })
    : await db.insert(knowledgeEnvironmentConnection).values({
        id: body.bindingId,
        organizationId: workspaceId,
        projectEnvironmentId: environmentId,
        connectionId: body.connectionId,
        ...values,
      }).returning({
        id: knowledgeEnvironmentConnection.id,
        projectEnvironmentId: knowledgeEnvironmentConnection.projectEnvironmentId,
        environmentRevision: knowledgeEnvironmentConnection.environmentRevision,
        connectionId: knowledgeEnvironmentConnection.connectionId,
        connectionRevision: knowledgeEnvironmentConnection.connectionRevision,
        role: knowledgeEnvironmentConnection.role,
        alias: knowledgeEnvironmentConnection.alias,
      });
  return privateJson({
    binding: {
      ...binding,
      currentConnectionRevision: scope.connectionRevision,
      connectionName: scope.connectionName,
      stale: false,
    },
  }, { status: existing ? 200 : 201 });
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, environmentId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(environmentId)) {
    return jsonError("Invalid Environment scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const parsed = await boundedJsonBody(request, 4 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (!body || typeof body.bindingId !== "string" || !isUuid(body.bindingId)) {
    return jsonError("Invalid Environment connection binding", 400);
  }
  const updated = await db.update(knowledgeEnvironmentConnection).set({
    revokedAt: new Date(),
  }).where(and(
    eq(knowledgeEnvironmentConnection.organizationId, workspaceId),
    eq(knowledgeEnvironmentConnection.projectEnvironmentId, environmentId),
    eq(knowledgeEnvironmentConnection.id, body.bindingId),
    isNull(knowledgeEnvironmentConnection.revokedAt),
  )).returning({ id: knowledgeEnvironmentConnection.id });
  if (updated.length !== 1) return jsonError("Environment connection binding not found", 404);
  return privateJson({ removed: true });
}
