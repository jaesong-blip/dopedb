import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { inspectGithubInstallation } from "@/lib/knowledge/github-app";
import {
  knowledgeMutationAuthority,
  knowledgeMutationAuthoritySql,
} from "@/lib/knowledge/mutation-authority";
import {
  knowledgeGithubInstallation,
  knowledgeGithubSetupState,
} from "@/lib/schema";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

function redirect(status: "connected" | "failed") {
  const url = new URL("/settings", env.appOrigin());
  url.searchParams.set("section", "knowledge");
  url.searchParams.set("github", status);
  return Response.redirect(url, 303);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const installationIdValue = url.searchParams.get("installation_id");
  if (
    !state
    || !/^[A-Za-z0-9_-]{32,256}$/.test(state)
    || !installationIdValue
    || !/^[1-9][0-9]{0,19}$/.test(installationIdValue)
  ) {
    return redirect("failed");
  }
  const stateHash = createHash("sha256").update(state).digest("hex");
  const [setup] = await db.select().from(knowledgeGithubSetupState).where(and(
    eq(knowledgeGithubSetupState.stateHash, stateHash),
    gt(knowledgeGithubSetupState.expiresAt, new Date()),
  )).limit(1);
  if (!setup) return redirect("failed");
  const authorization = await authorizeWorkspace(request, setup.organizationId, "manage");
  if (
    !authorization.ok
    || authorization.session.user.id !== setup.userId
  ) {
    return redirect("failed");
  }
  const authority = knowledgeMutationAuthority(
    authorization,
    setup.organizationId,
    "manage",
  );
  const consumed = await db.delete(knowledgeGithubSetupState).where(and(
    eq(knowledgeGithubSetupState.stateHash, stateHash),
    eq(knowledgeGithubSetupState.userId, authorization.session.user.id),
    gt(knowledgeGithubSetupState.expiresAt, new Date()),
    knowledgeMutationAuthoritySql(authority, setup.organizationId),
  )).returning({ stateHash: knowledgeGithubSetupState.stateHash });
  if (consumed.length !== 1) return redirect("failed");
  try {
    const installationId = BigInt(installationIdValue);
    const installation = await inspectGithubInstallation(installationId);
    if (
      installation.id !== Number(installationId)
      || installation.suspended_at
      || !Number.isSafeInteger(installation.account.id)
      || installation.account.id <= 0
      || !/^[A-Za-z0-9-]{1,255}$/.test(installation.account.login)
    ) {
      return redirect("failed");
    }
    const connected = await db.execute<{ id: string }>(sql`
      INSERT INTO ${knowledgeGithubInstallation}
        ("organization_id", "installation_id", "account_id", "account_login",
         "status", "created_by_user_id")
      SELECT ${setup.organizationId}, ${installationId}, ${String(installation.account.id)},
        ${installation.account.login}, 'active', ${authorization.session.user.id}
      WHERE ${knowledgeMutationAuthoritySql(authority, setup.organizationId)}
      ON CONFLICT ("organization_id", "installation_id") DO UPDATE SET
        "account_id" = EXCLUDED."account_id",
        "account_login" = EXCLUDED."account_login",
        "status" = 'active',
        "updated_at" = now()
      RETURNING "id"::text AS "id"
    `);
    if (connected.rows.length !== 1) return redirect("failed");
    return redirect("connected");
  } catch {
    return redirect("failed");
  }
}
