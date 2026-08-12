import { createHash, randomBytes } from "node:crypto";
import { lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { isUuid, jsonError, mutationAllowed, privateJson } from "@/lib/http";
import {
  githubInstallationUrl,
  githubKnowledgeConfigured,
} from "@/lib/knowledge/github-app";
import { knowledgeGithubSetupState } from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!githubKnowledgeConfigured()) {
    return jsonError("GitHub Project Knowledge is not configured", 503);
  }
  const state = randomBytes(32).toString("base64url");
  const stateHash = createHash("sha256").update(state).digest("hex");
  await db.batch([
    db.delete(knowledgeGithubSetupState)
      .where(lt(knowledgeGithubSetupState.expiresAt, new Date())),
    db.insert(knowledgeGithubSetupState).values({
      stateHash,
      organizationId: workspaceId,
      userId: authorization.session.user.id,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000),
    }),
  ]);
  return privateJson({ authorizationUrl: githubInstallationUrl(state) });
}
