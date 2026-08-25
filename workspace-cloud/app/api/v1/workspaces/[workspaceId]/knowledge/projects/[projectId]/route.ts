// Project deletion enforces workspace authority and optimistic revision checks
// before the store atomically revokes every Project-derived access path.

import { env } from "@/lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "@/lib/http";
import { knowledgeMutationAuthority } from "@/lib/knowledge/mutation-authority";
import { deleteKnowledgeProject } from "@/lib/knowledge/project-store";
import { authorizeWorkspace } from "@/lib/workspace-authorization";
import {
  databaseErrorCode,
  logKnowledgeMutationFailure,
} from "@/lib/workspace-server-log";

type RouteContext = {
  params: Promise<{ workspaceId: string; projectId: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
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
  const parsed = await boundedJsonBody(request, 4 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (
    !body
    || Object.keys(body).join(",") !== "expectedRevision"
    || typeof body.expectedRevision !== "number"
    || !Number.isSafeInteger(body.expectedRevision)
    || body.expectedRevision < 1
  ) {
    return jsonError("Invalid Project deletion", 400);
  }
  try {
    const outcome = await deleteKnowledgeProject({
      organizationId: workspaceId,
      projectId,
      expectedRevision: body.expectedRevision,
      authority: knowledgeMutationAuthority(authorization, workspaceId, "manage"),
    });
    if (outcome === "active_analyses") {
      return jsonError(
        "Delete this Project's Analysis Articles before deleting the Project",
        409,
      );
    }
    if (outcome === "stale") {
      return jsonError("Project changed or was already deleted", 409);
    }
    return privateJson({ deleted: true });
  } catch (error) {
    logKnowledgeMutationFailure({
      operation: "project_delete",
      databaseCode: databaseErrorCode(error),
    });
    return jsonError("Project could not be deleted", 500);
  }
}
