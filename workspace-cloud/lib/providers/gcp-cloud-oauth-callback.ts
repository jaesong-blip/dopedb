// Google identity sign-in and short-lived Cloud SQL setup share the one
// callback URI already registered for this OAuth client. A database-backed,
// one-use state decides which handler owns the response before Better Auth sees
// it; ordinary sign-in states never enter this path.
import "server-only";

import { createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { authoritativeSession } from "../authoritative-session";
import { db } from "../db";
import { env } from "../env";
import { sealProviderSetupCredential } from "../secret-envelope";
import {
  providerOauthState,
  providerSetupSession,
} from "../schema";
import { authorizeWorkspace } from "../workspace-authorization";
import { exchangeGcpCloudCode } from "./gcp-cloud-oauth";

function settingsUrl(workspaceId: string | null, setupId?: string) {
  const target = new URL("/settings", env.appOrigin());
  target.searchParams.set("provider", "gcpCloudSql");
  target.searchParams.set("status", setupId ? "authorised" : "failed");
  if (workspaceId) target.searchParams.set("workspace", workspaceId);
  if (setupId) target.searchParams.set("gcpSetup", setupId);
  return target;
}

function stateHash(request: Request) {
  const state = new URL(request.url).searchParams.get("state") ?? "";
  if (state.length < 32 || state.length > 256) return null;
  return createHash("sha256").update(state).digest("base64url");
}

export async function isGcpCloudSetupCallback(request: Request) {
  const hash = stateHash(request);
  if (!hash) return false;
  const row = await db.query.providerOauthState.findFirst({
    where: and(
      eq(providerOauthState.stateHash, hash),
      eq(providerOauthState.provider, "gcpCloudSql"),
      gt(providerOauthState.expiresAt, new Date()),
    ),
    columns: { id: true },
  });
  return Boolean(row);
}

export async function gcpCloudSetupCallbackResponse(request: Request) {
  const url = new URL(request.url);
  const hash = stateHash(request);
  const code = url.searchParams.get("code") ?? "";
  if (!hash || code.length < 8 || code.length > 2_048) {
    return Response.redirect(settingsUrl(null));
  }
  const session = await authoritativeSession(request);
  if (!session) {
    return Response.redirect(new URL(
      `/auth/sign-in?returnTo=${encodeURIComponent("/settings")}`,
      env.appOrigin(),
    ));
  }
  const consumed = await db.delete(providerOauthState).where(and(
    eq(providerOauthState.stateHash, hash),
    eq(providerOauthState.userId, session.user.id),
    eq(providerOauthState.provider, "gcpCloudSql"),
    gt(providerOauthState.expiresAt, new Date()),
  )).returning({ organizationId: providerOauthState.organizationId });
  const oauthState = consumed[0];
  if (!oauthState) return Response.redirect(settingsUrl(null));
  const authorization = await authorizeWorkspace(
    request,
    oauthState.organizationId,
    "manage",
  );
  if (!authorization.ok || authorization.session.user.id !== session.user.id) {
    return Response.redirect(settingsUrl(oauthState.organizationId));
  }
  try {
    const credential = await exchangeGcpCloudCode(code);
    const setupId = crypto.randomUUID();
    const expiresAt = new Date(Math.min(
      Date.parse(credential.expiresAt),
      Date.now() + 10 * 60 * 1_000,
    ));
    await db.transaction(async (tx) => {
      await tx.delete(providerSetupSession).where(lt(
        providerSetupSession.expiresAt,
        new Date(),
      ));
      await tx.insert(providerSetupSession).values({
        id: setupId,
        organizationId: oauthState.organizationId,
        userId: session.user.id,
        provider: "gcpCloudSql",
        encryptedCredential: sealProviderSetupCredential(setupId, credential),
        accountLabel: credential.email,
        expiresAt,
      });
    });
    return Response.redirect(settingsUrl(oauthState.organizationId, setupId));
  } catch {
    return Response.redirect(settingsUrl(oauthState.organizationId));
  }
}
