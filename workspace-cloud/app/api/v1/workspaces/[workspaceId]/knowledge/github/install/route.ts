import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { isUuid, jsonError, mutationAllowed, privateJson } from "@/lib/http";
import {
  githubInstallationUrl,
  githubKnowledgeConfigured,
} from "@/lib/knowledge/github-app";
import {
  knowledgeMutationAuthority,
  knowledgeMutationAuthoritySql,
} from "@/lib/knowledge/mutation-authority";
import { knowledgeGithubSetupState } from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const authority = knowledgeMutationAuthority(authorization, workspaceId, "manage");
  if (!githubKnowledgeConfigured()) {
    return jsonError("GitHub Project Knowledge is not configured", 503);
  }
  const state = randomBytes(32).toString("base64url");
  const stateHash = createHash("sha256").update(state).digest("hex");
  const setupResult = await db.execute<{ stateHash: string }>(sql`
    WITH actor_authority AS MATERIALIZED (
      SELECT 1 WHERE ${knowledgeMutationAuthoritySql(authority, workspaceId)}
    ), expired AS (
      DELETE FROM ${knowledgeGithubSetupState}
      WHERE "expires_at" < now()
        AND EXISTS (SELECT 1 FROM actor_authority)
    ), inserted AS (
      INSERT INTO ${knowledgeGithubSetupState}
        ("state_hash", "organization_id", "user_id", "expires_at")
      SELECT ${stateHash}, ${workspaceId}, ${authorization.session.user.id},
        now() + interval '10 minutes'
      FROM actor_authority
      RETURNING "state_hash" AS "stateHash"
    )
    SELECT "stateHash" FROM inserted
  `);
  if (setupResult.rows.length !== 1) return jsonError("Workspace access changed", 409);
  return privateJson({ authorizationUrl: githubInstallationUrl(state) });
}
