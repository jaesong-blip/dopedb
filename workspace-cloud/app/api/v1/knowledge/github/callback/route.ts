import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { authoritativeSession } from "@/lib/authoritative-session";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import {
  GithubKnowledgeRequestError,
  githubInstallationUserAuthorizationUrl,
  inspectGithubInstallation,
  parseGithubInstallationUserAuthorizationState,
  verifyGithubInstallationUserAccess,
  type GithubInstallation,
  type GithubInstallationUserAuthorizationState,
} from "@/lib/knowledge/github-app";
import {
  knowledgeMutationAuthority,
  knowledgeMutationAuthoritySql,
} from "@/lib/knowledge/mutation-authority";
import {
  knowledgeGithubInstallation,
  knowledgeGithubSetupState,
} from "@/lib/schema";
import {
  databaseErrorCode,
  logGithubKnowledgeSetupFailure,
} from "@/lib/workspace-server-log";
import { authorizeWorkspace } from "@/lib/workspace-authorization";

function redirect(status: "connected" | "failed") {
  const url = new URL("/auth/github/complete", env.appOrigin());
  url.searchParams.set("status", status);
  return Response.redirect(url, 303);
}

function redirectToSignIn(request: Request) {
  const callback = new URL(request.url);
  const signIn = new URL("/auth/sign-in", env.appOrigin());
  signIn.searchParams.set("returnTo", `${callback.pathname}${callback.search}`);
  return Response.redirect(signIn, 303);
}

function validInstallation(
  installation: GithubInstallation,
  installationId: bigint,
) {
  return installation.id === Number(installationId)
    && !installation.suspended_at
    && Number.isSafeInteger(installation.account.id)
    && installation.account.id > 0
    && /^[A-Za-z0-9-]{1,255}$/.test(installation.account.login);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  let setupState = "";
  let installationId = 0n;
  let userAuthorizationState: GithubInstallationUserAuthorizationState | null = null;
  try {
    if (code !== null) {
      if (!/^[A-Za-z0-9_-]{16,256}$/.test(code)) {
        throw new Error("Invalid GitHub user authorization code");
      }
      userAuthorizationState = parseGithubInstallationUserAuthorizationState(
        stateValue,
      );
      setupState = userAuthorizationState.setupState;
      installationId = userAuthorizationState.installationId;
    } else {
      const installationIdValue = url.searchParams.get("installation_id") ?? "";
      if (
        !/^[A-Za-z0-9_-]{32,256}$/.test(stateValue)
        || !/^[1-9][0-9]{0,19}$/.test(installationIdValue)
      ) {
        throw new Error("Invalid GitHub setup callback");
      }
      setupState = stateValue;
      installationId = BigInt(installationIdValue);
      if (installationId > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Invalid GitHub setup callback");
      }
    }
  } catch {
    logGithubKnowledgeSetupFailure({
      stage: "request_validation",
      kind: "invalid_request",
      status: 0,
      databaseCode: null,
    });
    return redirect("failed");
  }
  const stateHash = createHash("sha256").update(setupState).digest("hex");
  let stage = "setup_lookup";
  try {
    const [setup] = await db.select().from(knowledgeGithubSetupState).where(and(
      eq(knowledgeGithubSetupState.stateHash, stateHash),
      gt(knowledgeGithubSetupState.expiresAt, new Date()),
    )).limit(1);
    if (!setup) {
      logGithubKnowledgeSetupFailure({
        stage,
        kind: "expired_or_unknown_state",
        status: 0,
        databaseCode: null,
      });
      return redirect("failed");
    }
    stage = "workspace_authorization";
    const browserSession = await authoritativeSession(request);
    if (!browserSession || browserSession.user.id !== setup.userId) {
      if (code === null) return redirectToSignIn(request);
      logGithubKnowledgeSetupFailure({
        stage,
        kind: "unauthorized",
        status: browserSession ? 403 : 401,
        databaseCode: null,
      });
      return redirect("failed");
    }
    const authorization = await authorizeWorkspace(request, setup.organizationId, "manage");
    if (
      !authorization.ok
      || authorization.session.user.id !== setup.userId
    ) {
      logGithubKnowledgeSetupFailure({
        stage,
        kind: "unauthorized",
        status: authorization.ok ? 403 : authorization.status,
        databaseCode: null,
      });
      return redirect("failed");
    }
    const authority = knowledgeMutationAuthority(
      authorization,
      setup.organizationId,
      "manage",
    );
    stage = "installation_inspection";
    let installation = await inspectGithubInstallation(installationId);
    stage = "installation_validation";
    if (!validInstallation(installation, installationId)) {
      logGithubKnowledgeSetupFailure({
        stage,
        kind: "invalid_installation",
        status: 0,
        databaseCode: null,
      });
      return redirect("failed");
    }
    if (code === null) {
      return Response.redirect(
        githubInstallationUserAuthorizationUrl(setupState, installationId),
        303,
      );
    }
    if (!userAuthorizationState) {
      logGithubKnowledgeSetupFailure({
        stage: "request_validation",
        kind: "invalid_request",
        status: 0,
        databaseCode: null,
      });
      return redirect("failed");
    }
    stage = "user_authorization";
    const userCanAccessInstallation = await verifyGithubInstallationUserAccess(
      code,
      userAuthorizationState,
    );
    if (!userCanAccessInstallation) {
      logGithubKnowledgeSetupFailure({
        stage,
        kind: "installation_not_authorized",
        status: 403,
        databaseCode: null,
      });
      return redirect("failed");
    }
    // Re-read after user verification so suspension or account changes that race
    // the OAuth round trip cannot be persisted from the earlier setup response.
    stage = "installation_inspection";
    installation = await inspectGithubInstallation(installationId);
    stage = "installation_validation";
    if (!validInstallation(installation, installationId)) {
      logGithubKnowledgeSetupFailure({
        stage,
        kind: "invalid_installation",
        status: 0,
        databaseCode: null,
      });
      return redirect("failed");
    }
    stage = "state_consumption";
    const consumed = await db.delete(knowledgeGithubSetupState).where(and(
      eq(knowledgeGithubSetupState.stateHash, stateHash),
      eq(knowledgeGithubSetupState.userId, authorization.session.user.id),
      gt(knowledgeGithubSetupState.expiresAt, new Date()),
      knowledgeMutationAuthoritySql(authority, setup.organizationId),
    )).returning({ stateHash: knowledgeGithubSetupState.stateHash });
    if (consumed.length !== 1) {
      logGithubKnowledgeSetupFailure({
        stage,
        kind: "authority_changed",
        status: 0,
        databaseCode: null,
      });
      return redirect("failed");
    }
    stage = "installation_persistence";
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
    if (connected.rows.length !== 1) {
      logGithubKnowledgeSetupFailure({
        stage,
        kind: "authority_changed",
        status: 0,
        databaseCode: null,
      });
      return redirect("failed");
    }
    return redirect("connected");
  } catch (error) {
    const providerRequest = error instanceof GithubKnowledgeRequestError;
    const postgresCode = databaseErrorCode(error);
    logGithubKnowledgeSetupFailure({
      stage,
      kind: providerRequest
        ? "provider_request"
        : postgresCode
          ? "database"
          : "unexpected",
      status: providerRequest ? error.status : 0,
      databaseCode: postgresCode,
    });
    return redirect("failed");
  }
}
