import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { inspectGithubInstallation } from "@/lib/knowledge/github-app";
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
  const consumed = await db.delete(knowledgeGithubSetupState).where(and(
    eq(knowledgeGithubSetupState.stateHash, stateHash),
    eq(knowledgeGithubSetupState.userId, authorization.session.user.id),
    gt(knowledgeGithubSetupState.expiresAt, new Date()),
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
    await db.insert(knowledgeGithubInstallation).values({
      organizationId: setup.organizationId,
      installationId,
      accountId: String(installation.account.id),
      accountLogin: installation.account.login,
      status: "active",
      createdByUserId: authorization.session.user.id,
    }).onConflictDoUpdate({
      target: [
        knowledgeGithubInstallation.organizationId,
        knowledgeGithubInstallation.installationId,
      ],
      set: {
        accountId: String(installation.account.id),
        accountLogin: installation.account.login,
        status: "active",
        updatedAt: new Date(),
      },
    });
    return redirect("connected");
  } catch {
    return redirect("failed");
  }
}
