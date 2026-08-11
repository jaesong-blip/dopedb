import { and, eq } from "drizzle-orm";
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
  insertKnowledgeProject,
  KNOWLEDGE_RISK_CLASSES,
  type KnowledgeRiskClass,
} from "@/lib/knowledge/project-store";
import { knowledgeProject, knowledgeProjectEnvironment } from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";
import {
  databaseErrorCode,
  logKnowledgeMutationFailure,
} from "@/lib/workspace-server-log";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const [projects, environments] = await Promise.all([
    db.select().from(knowledgeProject).where(eq(knowledgeProject.organizationId, workspaceId)),
    db.select().from(knowledgeProjectEnvironment).where(eq(
      knowledgeProjectEnvironment.organizationId,
      workspaceId,
    )),
  ]);
  return privateJson({
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      revision: project.revision,
      environments: environments.filter((environment) => environment.projectId === project.id)
        .map((environment) => ({
          id: environment.id,
          name: environment.name,
          riskClass: environment.riskClass,
          revision: environment.revision,
        })),
    })),
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const parsed = await boundedJsonBody(request, 16 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  const environments = Array.isArray(body?.environments) ? body.environments : [];
  if (
    !body
    || typeof body.name !== "string"
    || !isSafeDisplayText(body.name.trim(), 512)
    || environments.length < 1
    || environments.length > 20
    || !environments.every((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const environment = value as Record<string, unknown>;
      return Object.keys(environment).sort().join(",") === "name,riskClass"
        && typeof environment.name === "string"
        && isSafeDisplayText(environment.name.trim(), 512)
        && typeof environment.riskClass === "string"
        && KNOWLEDGE_RISK_CLASSES.includes(
          environment.riskClass as KnowledgeRiskClass,
        );
    })
  ) {
    return jsonError("Invalid Project Knowledge scope", 400);
  }
  const projectName = body.name.trim();
  const normalizedEnvironments = environments.map((value) => {
    const environment = value as {
      name: string;
      riskClass: KnowledgeRiskClass;
    };
    return {
      name: environment.name.trim(),
      riskClass: environment.riskClass,
    };
  });
  if (
    new Set(normalizedEnvironments.map((environment) => environment.name)).size !==
    normalizedEnvironments.length
  ) {
    return jsonError("Environment names must be unique", 400);
  }
  try {
    const created = await insertKnowledgeProject({
      organizationId: workspaceId,
      name: projectName,
      environments: normalizedEnvironments,
    });
    if (!created) {
      return jsonError("Project name is already in use", 409);
    }
    return privateJson({ project: created }, { status: 201 });
  } catch (error) {
    logKnowledgeMutationFailure({
      operation: "project_create",
      databaseCode: databaseErrorCode(error),
    });
    return jsonError("Project could not be created", 500);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const parsed = await boundedJsonBody(request, 8 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (
    !body
    || typeof body.projectId !== "string"
    || !isUuid(body.projectId)
    || typeof body.expectedRevision !== "number"
    || !Number.isSafeInteger(body.expectedRevision)
    || body.expectedRevision < 1
    || typeof body.name !== "string"
    || !isSafeDisplayText(body.name.trim(), 512)
  ) return jsonError("Invalid Project update", 400);
  const updated = await db.update(knowledgeProject).set({
    name: body.name.trim(),
    revision: body.expectedRevision + 1,
    updatedAt: new Date(),
  }).where(and(
    eq(knowledgeProject.organizationId, workspaceId),
    eq(knowledgeProject.id, body.projectId),
    eq(knowledgeProject.revision, body.expectedRevision),
  )).returning({ id: knowledgeProject.id, revision: knowledgeProject.revision });
  if (updated.length !== 1) return jsonError("Project revision changed", 409);
  return privateJson({ project: updated[0] });
}
