// Workspace provider integration inventory and OAuth initiation. Secret material is
// omitted by explicit projection and OAuth state is single-use, hashed server data.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { db } from "../../../../../../lib/db";
import { env } from "../../../../../../lib/env";
import {
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../lib/http";
import { providerCatalog } from "../../../../../../lib/provider-catalog";
import {
  parseManagedProviderResource,
  revokeActiveLeases,
} from "../../../../../../lib/provider-integrations";
import { persistProviderIntegration } from "../../../../../../lib/provider-integration-mutation-store";
import {
  claimRevocationGate,
  releaseRevocationGateClaim,
  type RevocationGateClaim,
} from "../../../../../../lib/revocation-gates";
import {
  isPlanetScaleConfigured,
  planetScaleAuthorizationUrl,
  PlanetScaleRequestError,
} from "../../../../../../lib/providers/planetscale";
import {
  inspectNeonCredential,
} from "../../../../../../lib/providers/neon";
import {
  gcpCloudSqlIntegrationIdentity,
  gcpCloudSqlPrincipalClaims,
  gcpLocalVerificationTarget,
  parseGcpCloudSqlCredential,
  type GcpLocalVerificationTarget,
} from "../../../../../../lib/providers/gcp-cloud-sql-core";
import {
  validateGcpCloudSqlCredential,
  vercelOidcToken,
} from "../../../../../../lib/providers/gcp-cloud-sql";
import {
  gcpCloudAuthorizationUrl,
} from "../../../../../../lib/providers/gcp-cloud-oauth";
import { ProviderRequestError } from "../../../../../../lib/providers/provider-types";
import {
  type NeonCredential,
} from "../../../../../../lib/providers/neon-core";
import {
  openProviderBootstrapTicket,
  openProviderCredential,
  sealProviderCredential,
} from "../../../../../../lib/secret-envelope";
import {
  providerOauthState,
  providerSetupSession,
  workspaceConnection,
  workspaceProviderIntegration,
  workspaceProviderPrincipalClaim,
} from "../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export const maxDuration = 300;

function sameSecret(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function postgresErrorCode(error: unknown) {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return null;
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const [integrations, managedRows] = await Promise.all([
    db.select({
      id: workspaceProviderIntegration.id,
      provider: workspaceProviderIntegration.provider,
      status: workspaceProviderIntegration.status,
      generation: workspaceProviderIntegration.generation,
      displayName: workspaceProviderIntegration.displayName,
      credentialExpiresAt: workspaceProviderIntegration.credentialExpiresAt,
      grantedScope: workspaceProviderIntegration.grantedScope,
      createdAt: workspaceProviderIntegration.createdAt,
      updatedAt: workspaceProviderIntegration.updatedAt,
    }).from(workspaceProviderIntegration).where(and(
      eq(workspaceProviderIntegration.organizationId, workspaceId),
      inArray(workspaceProviderIntegration.status, ["active", "reconnect_required"]),
    )),
    db.select({
      connectionId: workspaceConnection.id,
      integrationId: workspaceConnection.providerIntegrationId,
      resource: workspaceConnection.providerResource,
    }).from(workspaceConnection).where(and(
      eq(workspaceConnection.organizationId, workspaceId),
      eq(workspaceConnection.credentialMode, "managed"),
      isNull(workspaceConnection.deletedAt),
    )),
  ]);
  const managedConnections = managedRows.flatMap((row) => {
    if (!row.integrationId) return [];
    const provider = integrations.find((item) => item.id === row.integrationId)?.provider;
    if (!provider) return [];
    try {
      return [{
        connectionId: row.connectionId,
        integrationId: row.integrationId,
        provider,
        resource: parseManagedProviderResource(provider, row.resource),
      }];
    } catch {
      return [];
    }
  });
  return privateJson({
    // Explicit browser projection: internal adapter/provisioning fields must not
    // become a public contract through object spreading.
    providers: providerCatalog.map((provider) => ({
      id: provider.id,
      name: provider.name,
      supportedEngines: [...provider.supportedEngines],
      leaseSeconds: provider.leaseSeconds,
      setupKind: provider.setupKind,
      resourceLevels: provider.resourceLevels.map((level) => ({ ...level })),
      note: provider.note,
      configured: provider.id === "planetScale"
        ? isPlanetScaleConfigured()
        : provider.id === "neon"
          ? true
          : provider.id === "gcpCloudSql"
            ? Boolean(vercelOidcToken(request))
            : false,
    })),
    // Server-held encrypted integration credentials are explicitly managed mode;
    // member-local/device secrets are intentionally absent from this API.
    integrations: integrations.map(({ generation, ...integration }) => ({
      ...integration,
      // BigInt is not JSON-serializable. Decimal text preserves the exact
      // provider credential/policy CAS generation for non-secret clients.
      generation: generation.toString(),
      credentialMode: "managed" as const,
      reconnectRequired: integration.status === "reconnect_required",
    })),
    managedConnections,
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const body = (await request.json().catch(() => null)) as {
    provider?: unknown;
    configuration?: unknown;
    setupId?: unknown;
    bootstrapTicket?: unknown;
  } | null;
  if (
    body?.provider !== "planetScale"
    && body?.provider !== "neon"
    && body?.provider !== "gcpCloudSql"
  ) {
    return jsonError("Managed access for this provider is not available", 409);
  }

  let stage:
    | "provider_authorization"
    | "gcp_setup_ticket"
    | "gcp_credential_validation"
    | "integration_lookup"
    | "credential_sealing"
    | "lease_revocation"
    | "integration_persistence"
    | "setup_consumption" = "provider_authorization";
  try {
    if (
      body.provider === "planetScale"
      || (body.provider === "gcpCloudSql" && body.bootstrapTicket === undefined)
    ) {
      const state = randomBytes(32).toString("base64url");
      const stateHash = createHash("sha256").update(state).digest("base64url");
      await db.delete(providerOauthState)
        .where(lt(providerOauthState.expiresAt, new Date()));
      await db.insert(providerOauthState).values({
        organizationId: workspaceId,
        userId: authorization.session.user.id,
        provider: body.provider,
        stateHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1_000),
      });
      return privateJson({
        authorizationUrl: body.provider === "planetScale"
          ? planetScaleAuthorizationUrl(state)
          : gcpCloudAuthorizationUrl(state),
      });
    }

    let credential: NeonCredential | ReturnType<typeof parseGcpCloudSqlCredential>;
    let externalAccountId: string;
    let displayName: string;
    let grantedScope: string;
    let neonConfigurationCredential: NeonCredential | null = null;
    let gcpIdentity:
      | ReturnType<typeof gcpCloudSqlIntegrationIdentity>
      | null = null;
    let localVerificationTarget: GcpLocalVerificationTarget | null = null;
    let production: boolean | null = null;
    if (body.provider === "neon") {
      const configuration = body.configuration as Record<string, unknown> | null;
      const apiKey = typeof configuration?.apiKey === "string"
        ? configuration.apiKey.trim()
        : "";
      const organizationId = typeof configuration?.organizationId === "string"
        && configuration.organizationId.trim()
        ? configuration.organizationId.trim()
        : null;
      if (
        apiKey.length < 20
        || apiKey.length > 512
        || /\s/.test(apiKey)
        || (organizationId !== null
          && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(organizationId))
      ) {
        return jsonError("Invalid Neon API key configuration", 400);
      }
      credential = { apiKey, organizationId };
      neonConfigurationCredential = credential;
      const info = await inspectNeonCredential(credential);
      externalAccountId = info.externalAccountId;
      displayName = info.displayName;
      grantedScope = `projects:${info.projectCount}:${info.scopeFingerprint.slice(0, 16)}`;
    } else {
      stage = "gcp_setup_ticket";
      if (
        typeof body.setupId !== "string"
        || !isUuid(body.setupId)
        || typeof body.bootstrapTicket !== "string"
        || body.bootstrapTicket.length < 80
        || body.bootstrapTicket.length > 32_768
      ) {
        return jsonError("A completed Google Cloud setup is required", 400);
      }
      const setup = await db.query.providerSetupSession.findFirst({
        where: and(
          eq(providerSetupSession.id, body.setupId),
          eq(providerSetupSession.organizationId, workspaceId),
          eq(providerSetupSession.userId, authorization.session.user.id),
          eq(providerSetupSession.provider, "gcpCloudSql"),
          gt(providerSetupSession.expiresAt, new Date()),
          isNull(providerSetupSession.consumedAt),
        ),
        columns: { id: true },
      });
      if (!setup) {
        return jsonError("Google Cloud setup session expired", 410);
      }
      try {
        const ticket = openProviderBootstrapTicket<{
          configuration?: unknown;
          production?: unknown;
        }>(body.setupId, body.bootstrapTicket);
        credential = parseGcpCloudSqlCredential(
          ticket.configuration,
        );
        if (typeof ticket.production !== "boolean") {
          throw new Error("missing production classification");
        }
        production = ticket.production;
      } catch {
        return jsonError("Invalid Google Cloud setup ticket", 400);
      }
      const oidcToken = vercelOidcToken(request);
      if (!oidcToken) {
        return jsonError("Vercel OIDC is not enabled for this deployment", 503);
      }
      stage = "gcp_credential_validation";
      await validateGcpCloudSqlCredential(credential, oidcToken);
      gcpIdentity = gcpCloudSqlIntegrationIdentity(credential);
      localVerificationTarget = gcpLocalVerificationTarget(credential);
      externalAccountId = gcpIdentity.externalAccountId;
      displayName = `GCP Cloud SQL · ${credential.projectId} / ${credential.instanceId}`;
      grantedScope = credential.writeServiceAccountEmail
        ? "cloudsql.read cloudsql.write"
        : "cloudsql.read";
    }

    const provider = body.provider;
    stage = "integration_lookup";
    type ExistingIntegration = {
      id: string;
      status: string;
      revokedAt: Date | null;
      revocationPendingAt: Date | null;
      generation: bigint;
      updatedAt: Date;
    };
    let existing: ExistingIntegration | undefined;
    if (provider === "gcpCloudSql" && gcpIdentity) {
      const principalClaims = gcpCloudSqlPrincipalClaims(gcpIdentity);
      const claimedPrincipals = await db.select({
        principalFingerprint:
          workspaceProviderPrincipalClaim.principalFingerprint,
        targetFingerprint: workspaceProviderPrincipalClaim.targetFingerprint,
        integrationId: workspaceProviderIntegration.id,
        organizationId: workspaceProviderIntegration.organizationId,
        provider: workspaceProviderIntegration.provider,
        status: workspaceProviderIntegration.status,
        revokedAt: workspaceProviderIntegration.revokedAt,
        revocationPendingAt: workspaceProviderIntegration.revocationPendingAt,
        generation: workspaceProviderIntegration.generation,
        updatedAt: workspaceProviderIntegration.updatedAt,
      }).from(workspaceProviderPrincipalClaim).innerJoin(
        workspaceProviderIntegration,
        eq(
          workspaceProviderPrincipalClaim.integrationId,
          workspaceProviderIntegration.id,
        ),
      ).where(inArray(
        workspaceProviderPrincipalClaim.principalFingerprint,
        principalClaims.map((claim) => claim.principalFingerprint),
      ));
      if (claimedPrincipals.some((row) => (
        row.organizationId !== workspaceId
        || row.provider !== "gcpCloudSql"
        || row.status !== "active"
        || row.revokedAt !== null
        || row.targetFingerprint !== gcpIdentity.instance
      ))) {
        return jsonError(
          "Each Cloud SQL instance must use dedicated service accounts",
          409,
        );
      }
      const principalIntegrationIds = new Set(
        claimedPrincipals.map((row) => row.integrationId),
      );
      if (principalIntegrationIds.size > 1) {
        return jsonError(
          "Each Cloud SQL instance must use dedicated service accounts",
          409,
        );
      }
      const targetRows = await db.select({
        id: workspaceProviderIntegration.id,
        status: workspaceProviderIntegration.status,
        revokedAt: workspaceProviderIntegration.revokedAt,
        revocationPendingAt: workspaceProviderIntegration.revocationPendingAt,
        generation: workspaceProviderIntegration.generation,
        updatedAt: workspaceProviderIntegration.updatedAt,
      }).from(workspaceProviderPrincipalClaim).innerJoin(
        workspaceProviderIntegration,
        eq(
          workspaceProviderPrincipalClaim.integrationId,
          workspaceProviderIntegration.id,
        ),
      ).where(and(
        eq(workspaceProviderPrincipalClaim.targetFingerprint, gcpIdentity.instance),
        eq(workspaceProviderIntegration.organizationId, workspaceId),
        eq(workspaceProviderIntegration.provider, "gcpCloudSql"),
        eq(workspaceProviderIntegration.status, "active"),
        isNull(workspaceProviderIntegration.revokedAt),
      ));
      const targetIntegrations = new Map(
        targetRows.map((row) => [row.id, row]),
      );
      if (targetIntegrations.size > 1) {
        return jsonError(
          "Cloud SQL target is already connected more than once",
          409,
        );
      }
      const principalIntegrationId = [...principalIntegrationIds][0];
      const targetIntegration = [...targetIntegrations.values()][0];
      if (
        principalIntegrationId
        && targetIntegration
        && principalIntegrationId !== targetIntegration.id
      ) {
        return jsonError(
          "Each Cloud SQL instance must use dedicated service accounts",
          409,
        );
      }
      if (targetIntegration) {
        existing = targetIntegration;
      } else if (principalIntegrationId) {
        const principalIntegration = claimedPrincipals.find(
          (row) => row.integrationId === principalIntegrationId,
        );
        if (principalIntegration) {
          existing = {
            id: principalIntegration.integrationId,
            status: principalIntegration.status,
            revokedAt: principalIntegration.revokedAt,
            revocationPendingAt:
              principalIntegration.revocationPendingAt,
            generation: principalIntegration.generation,
            updatedAt: principalIntegration.updatedAt,
          };
        }
      }
      if (!existing) {
        existing = await db.query.workspaceProviderIntegration.findFirst({
          where: and(
            eq(workspaceProviderIntegration.organizationId, workspaceId),
            eq(workspaceProviderIntegration.provider, "gcpCloudSql"),
            eq(
              workspaceProviderIntegration.externalAccountId,
              externalAccountId,
            ),
          ),
          columns: {
            id: true,
            status: true,
            revokedAt: true,
            revocationPendingAt: true,
            generation: true,
            updatedAt: true,
          },
        });
      }
    } else {
      existing = await db.query.workspaceProviderIntegration.findFirst({
        where: and(
          eq(workspaceProviderIntegration.organizationId, workspaceId),
          eq(workspaceProviderIntegration.provider, provider),
          eq(workspaceProviderIntegration.externalAccountId, externalAccountId),
        ),
        columns: {
          id: true,
          status: true,
          revokedAt: true,
          revocationPendingAt: true,
          generation: true,
          updatedAt: true,
        },
      });
      if (!existing && provider === "neon") {
        // One-time compatibility path for integrations created before Neon replaced
        // /auth with scoped user/organization identity. The secret never leaves this
        // server-side comparison and the row is rewritten to the v2 identity below.
        const legacyRows = await db.select({
          id: workspaceProviderIntegration.id,
          externalAccountId: workspaceProviderIntegration.externalAccountId,
          encryptedCredential: workspaceProviderIntegration.encryptedCredential,
          status: workspaceProviderIntegration.status,
          revokedAt: workspaceProviderIntegration.revokedAt,
          revocationPendingAt: workspaceProviderIntegration.revocationPendingAt,
          generation: workspaceProviderIntegration.generation,
          updatedAt: workspaceProviderIntegration.updatedAt,
        }).from(workspaceProviderIntegration).where(and(
          eq(workspaceProviderIntegration.organizationId, workspaceId),
          eq(workspaceProviderIntegration.provider, "neon"),
          eq(workspaceProviderIntegration.status, "active"),
          isNull(workspaceProviderIntegration.revokedAt),
        ));
        existing = legacyRows.find((row) => {
          if (row.externalAccountId.startsWith("neon:v2:")) return false;
          try {
            const stored = openProviderCredential<NeonCredential>(
              row.id,
              row.encryptedCredential,
            );
            return neonConfigurationCredential !== null
              && sameSecret(stored.apiKey, neonConfigurationCredential.apiKey);
          } catch {
            return false;
          }
        });
      }
    }
    const integrationId = existing?.id ?? crypto.randomUUID();
    stage = "credential_sealing";
    const encryptedCredential = sealProviderCredential(integrationId, credential);
    const now = new Date();
    let reconnectClaim: RevocationGateClaim | null = null;
    let reconnectRevoked = 0;
    if (existing?.status === "active" && !existing.revokedAt) {
      stage = "lease_revocation";
      reconnectClaim = await claimRevocationGate({
        kind: "integration",
        organizationId: workspaceId,
        integrationId,
      });
      if (!reconnectClaim) {
        return jsonError("Another provider access change is already in progress", 409);
      }
      let revocation;
      try {
        revocation = await revokeActiveLeases({
          organizationId: workspaceId,
          integrationId,
        });
      } catch (error) {
        await releaseRevocationGateClaim(reconnectClaim).catch(() => false);
        throw error;
      }
      if (revocation.deferred > 0) {
        await releaseRevocationGateClaim(reconnectClaim).catch(() => false);
        return jsonError(
          "Active database access could not be revoked yet. Retry reconnecting.",
          409,
        );
      }
      reconnectRevoked = revocation.revoked;
    } else if (existing?.revocationPendingAt) {
      return jsonError("Another provider access change is already in progress", 409);
    }
    // Provider I/O above is intentionally outside the database transaction. This
    // is the sole durable create/reconnect boundary: a post-I/O revocation,
    // demotion or generation change yields no integration, claim, audit or
    // credential-refresh response.
    stage = "integration_persistence";
    const persisted = await persistProviderIntegration({
      authority: {
        organizationId: workspaceId,
        membershipId: authorization.membership.id,
        userId: authorization.session.user.id,
        sessionId: authorization.session.session.id,
        role: authorization.role,
      },
      integrationId,
      provider,
      externalAccountId,
      displayName,
      encryptedCredential,
      credentialExpiresAt: null,
      grantedScope,
      localVerificationTarget,
      now,
      requestId: crypto.randomUUID(),
      revokedLeases: reconnectRevoked,
      existing,
      reconnectClaimId: reconnectClaim?.claimId,
      principalClaims: provider === "gcpCloudSql" && gcpIdentity
        ? gcpCloudSqlPrincipalClaims(gcpIdentity)
        : [],
      production,
    }).catch(async (error) => {
      if (reconnectClaim) {
        await releaseRevocationGateClaim(reconnectClaim).catch(() => false);
      }
      throw error;
    });
    if (!persisted.ok) {
      if (reconnectClaim) {
        await releaseRevocationGateClaim(reconnectClaim).catch(() => false);
      }
      return jsonError(
        existing
          ? "Provider access changed concurrently. Retry connecting."
          : "Workspace access denied",
        existing ? 409 : 403,
      );
    }
    if (provider === "gcpCloudSql" && typeof body.setupId === "string") {
      stage = "setup_consumption";
      await db.update(providerSetupSession)
        .set({ consumedAt: now })
        .where(and(
          eq(providerSetupSession.id, body.setupId),
          eq(providerSetupSession.organizationId, workspaceId),
          eq(providerSetupSession.userId, authorization.session.user.id),
          isNull(providerSetupSession.consumedAt),
        ))
        .catch(() => undefined);
    }
    return privateJson({
      integration: {
        id: persisted.id,
        provider,
        displayName,
        grantedScope,
        updatedAt: now.toISOString(),
      },
    }, { status: existing ? 200 : 201 });

  } catch (error) {
    const postgresCode = postgresErrorCode(error);
    console.error("provider_connection_failed", {
      provider: body.provider,
      stage,
      postgresCode,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    if (body.provider === "gcpCloudSql" && postgresCode === "23505") {
      return jsonError(
        "Cloud SQL service accounts or target are already connected",
        409,
      );
    }
    if (
      error instanceof PlanetScaleRequestError
      || error instanceof ProviderRequestError
    ) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Provider connection could not be verified", 502);
  }
}
