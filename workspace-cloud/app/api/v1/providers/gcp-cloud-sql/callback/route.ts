// Google Cloud setup callback. The one-use OAuth state is bound to the current
// Better Auth user; the access token is encrypted into a ten-minute setup row.
import { createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { authoritativeSession } from "../../../../../../lib/authoritative-session";
import { db } from "../../../../../../lib/db";
import { env } from "../../../../../../lib/env";
import { exchangeGcpCloudCode } from "../../../../../../lib/providers/gcp-cloud-oauth";
import { sealProviderSetupCredential } from "../../../../../../lib/secret-envelope";
import {
  providerOauthState,
  providerSetupSession,
} from "../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../lib/workspace-authorization";

function settingsUrl(workspaceId: string | null, setupId?: string) {
  const target = new URL("/settings", env.appOrigin());
  target.searchParams.set("provider", "gcpCloudSql");
  target.searchParams.set("status", setupId ? "authorised" : "failed");
  if (workspaceId) target.searchParams.set("workspace", workspaceId);
  if (setupId) target.searchParams.set("gcpSetup", setupId);
  return target;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (state.length < 32 || state.length > 256 || code.length < 8 || code.length > 2_048) {
    return Response.redirect(settingsUrl(null));
  }
  const session = await authoritativeSession(request);
  if (!session) {
    return Response.redirect(new URL(
      `/auth/sign-in?returnTo=${encodeURIComponent("/settings")}`,
      env.appOrigin(),
    ));
  }
  const stateHash = createHash("sha256").update(state).digest("base64url");
  const consumed = await db.delete(providerOauthState).where(and(
    eq(providerOauthState.stateHash, stateHash),
    eq(providerOauthState.userId, session.user.id),
    eq(providerOauthState.provider, "gcpCloudSql"),
    gt(providerOauthState.expiresAt, new Date()),
  )).returning({ organizationId: providerOauthState.organizationId });
  const oauthState = consumed[0];
  if (!oauthState) return Response.redirect(settingsUrl(null));
  const authorization = await authorizeWorkspace(request, oauthState.organizationId, "manage");
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
