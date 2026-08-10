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
import { knowledgeProject, knowledgeProjectEnvironment } from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = {
  params: Promise<{ workspaceId: string; projectId: string }>;
};

const RISK_CLASSES = [
  "production",
  "staging",
  "development",
  "test",
  "custom",
] as const;

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, projectId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(projectId)) {
    return jsonError("Invalid Project scope", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) {
    return jsonError(authorization.error, authorization.status);
  }
  const parsed = await boundedJsonBody(request, 8 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (
    !body
    || Object.keys(body).sort().join(",") !== "expectedProjectRevision,name,riskClass"
    || typeof body.expectedProjectRevision !== "number"
    || !Number.isSafeInteger(body.expectedProjectRevision)
    || body.expectedProjectRevision < 1
    || typeof body.name !== "string"
    || !isSafeDisplayText(body.name.trim(), 512)
    || typeof body.riskClass !== "string"
    || !RISK_CLASSES.includes(body.riskClass as (typeof RISK_CLASSES)[number])
  ) {
    return jsonError("Invalid Environment", 400);
  }

  const expectedProjectRevision = body.expectedProjectRevision;
  const environmentName = body.name.trim();
  const riskClass = body.riskClass as (typeof RISK_CLASSES)[number];
  try {
    const project = await db.transaction(async (transaction) => {
      const updatedProjects = await transaction.update(knowledgeProject).set({
        revision: expectedProjectRevision + 1,
        updatedAt: new Date(),
      }).where(and(
        eq(knowledgeProject.organizationId, workspaceId),
        eq(knowledgeProject.id, projectId),
        eq(knowledgeProject.revision, expectedProjectRevision),
      )).returning({
        id: knowledgeProject.id,
        name: knowledgeProject.name,
        revision: knowledgeProject.revision,
      });
      if (updatedProjects.length !== 1) {
        throw new Error("project-revision-changed");
      }
      await transaction.insert(knowledgeProjectEnvironment).values({
        organizationId: workspaceId,
        projectId,
        name: environmentName,
        production: riskClass === "production",
        riskClass,
      });
      const environments = await transaction.select({
        id: knowledgeProjectEnvironment.id,
        name: knowledgeProjectEnvironment.name,
        riskClass: knowledgeProjectEnvironment.riskClass,
        revision: knowledgeProjectEnvironment.revision,
      }).from(knowledgeProjectEnvironment).where(and(
        eq(knowledgeProjectEnvironment.organizationId, workspaceId),
        eq(knowledgeProjectEnvironment.projectId, projectId),
      ));
      return { ...updatedProjects[0], environments };
    });
    return privateJson({ project }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "project-revision-changed") {
      return jsonError("Project revision changed", 409);
    }
    return jsonError("Environment name is already in use", 409);
  }
}
