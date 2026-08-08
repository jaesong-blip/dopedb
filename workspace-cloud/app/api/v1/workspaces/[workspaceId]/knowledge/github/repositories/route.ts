import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { isUuid, jsonError, privateJson } from "@/lib/http";
import { listGithubRepositories } from "@/lib/knowledge/github-app";
import { knowledgeGithubInstallation } from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const installations = await db.select({
    id: knowledgeGithubInstallation.id,
    installationId: knowledgeGithubInstallation.installationId,
    accountLogin: knowledgeGithubInstallation.accountLogin,
  }).from(knowledgeGithubInstallation).where(and(
    eq(knowledgeGithubInstallation.organizationId, workspaceId),
    eq(knowledgeGithubInstallation.status, "active"),
  ));
  try {
    const inventories = await Promise.all(installations.map(async (installation) => ({
      installationId: installation.id,
      accountLogin: installation.accountLogin,
      repositories: (await listGithubRepositories(installation.installationId)).map((repository) => ({
        id: String(repository.id),
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        private: repository.private,
        archived: repository.archived,
      })),
    })));
    return privateJson({ installations: inventories });
  } catch {
    return jsonError("GitHub repository inventory is unavailable", 424);
  }
}
