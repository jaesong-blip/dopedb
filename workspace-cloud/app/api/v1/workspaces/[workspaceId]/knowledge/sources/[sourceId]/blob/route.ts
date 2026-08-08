import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
} from "@/lib/http";
import { githubSourceManifest, readGithubBlob } from "@/lib/knowledge/github-app";
import { knowledgeGithubInstallation, knowledgeSource } from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string; sourceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, sourceId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(sourceId)) return jsonError("Invalid source id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const parsed = await boundedJsonBody(request, 8 * 1024);
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (
    !body
    || typeof body.path !== "string"
    || body.path.length > 4_096
    || typeof body.blobSha !== "string"
    || !/^[0-9a-f]{40}$/.test(body.blobSha)
  ) {
    return jsonError("Invalid source blob request", 400);
  }
  const [source] = await db.select({
    repository: knowledgeSource.repositoryFullName,
    commitSha: knowledgeSource.commitSha,
    installationId: knowledgeGithubInstallation.installationId,
  }).from(knowledgeSource).innerJoin(
    knowledgeGithubInstallation,
    and(
      eq(knowledgeGithubInstallation.organizationId, knowledgeSource.organizationId),
      eq(knowledgeGithubInstallation.id, knowledgeSource.githubInstallationId),
      eq(knowledgeGithubInstallation.status, "active"),
    ),
  ).where(and(
    eq(knowledgeSource.organizationId, workspaceId),
    eq(knowledgeSource.id, sourceId),
    eq(knowledgeSource.provider, "github"),
    isNull(knowledgeSource.revokedAt),
  )).limit(1);
  if (!source?.repository || !source.commitSha) return jsonError("Knowledge source not found", 404);
  try {
    const manifest = await githubSourceManifest(
      source.installationId,
      source.repository,
      source.commitSha,
    );
    if (!manifest.some((file) => file.path === body.path && file.blobSha === body.blobSha)) {
      return jsonError("Source blob is outside the approved snapshot", 403);
    }
    const bytes = await readGithubBlob(source.installationId, source.repository, body.blobSha);
    return new Response(bytes, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return jsonError("GitHub source blob is unavailable", 424);
  }
}
