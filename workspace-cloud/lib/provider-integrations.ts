// Server-side provider integration and lease lifecycle. This module is the only
// database-facing code allowed to decrypt provider authorization credentials.
import "server-only";

import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import {
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceCredentialLease,
  member,
  session,
  workspaceProviderDiscoveryReceipt,
  workspaceProviderIntegration,
  workspaceProviderResource,
} from "./schema";
import {
  allowDiscoveryImport,
  providerImportProjection,
} from "./providers/import-projection";
import { MAX_PROVIDER_RESULTS } from "./providers/adapter-contract";
import { openProviderCredential, sealProviderCredential } from "./secret-envelope";
import {
  claimPlanetScaleCredentialRefresh,
  finalizePlanetScaleCredentialRefresh,
  markPlanetScaleCredentialRefreshRemoteStarted,
  requirePlanetScaleCredentialReconnect,
} from "./provider-integration-mutation-store";
import {
  issuePlanetScaleLease,
  PlanetScaleRequestError,
  refreshPlanetScaleToken,
  revokePlanetScaleAuthorization,
  revokePlanetScaleLease,
  validatePlanetScaleResource,
  listPlanetScaleBranches,
  listPlanetScaleDatabases,
  listPlanetScaleOrganizations,
  type PlanetScaleResource,
  type PlanetScaleToken,
} from "./providers/planetscale";
import { missingPlanetScaleManagedScopes } from "./providers/planetscale-core";
import {
  issueNeonLease,
  listNeonBranches,
  listNeonDatabases,
  listNeonProjects,
  neonRoleForLease,
  revokeNeonLease,
  validateNeonResource,
} from "./providers/neon";
import {
  parseNeonResource,
  type NeonCredential,
  type NeonResource,
} from "./providers/neon-core";
import {
  issueGcpCloudSqlLease,
  listGcpCloudSqlDatabases,
  listGcpCloudSqlInstances,
  listGcpProjects,
  validateGcpCloudSqlResource,
} from "./providers/gcp-cloud-sql";
import {
  parseGcpCloudSqlResource,
  parseGcpCloudSqlCredential,
  gcpLocalVerificationTarget as projectGcpLocalVerificationTarget,
  type GcpCloudSqlCredential,
  type GcpLocalVerificationTarget,
  type GcpCloudSqlResource,
} from "./providers/gcp-cloud-sql-core";
import {
  ProviderRequestError,
  type ManagedProviderLease,
  type ProviderResourceItem,
} from "./providers/provider-types";
import {
  finalizeManagedLeaseIfUnblocked,
  revocationGateLockKey,
  reserveManagedLeaseIfUnblocked,
  type ManagedLeaseAuthority,
} from "./revocation-gates";
import type { WorkspaceRoleName } from "./workspace-permissions";

export type ActiveProviderIntegration = {
  id: string;
  organizationId: string;
  provider: string;
  encryptedCredential: string;
  credentialExpiresAt: Date | null;
  generation: bigint;
  updatedAt: Date;
};

export type ProviderMutationAuthority = {
  organizationId: string;
  membershipId: string;
  userId: string;
  sessionId: string;
  role: WorkspaceRoleName;
  // A current lease may authorize consumption of an already-valid token. It
  // must never widen a shared credential mutation, which sets requireManager.
  lease?: {
    connectionId: string;
    connectionRevision: number;
    providerResourceId: string;
  };
};

function hasStrictGcpLocalVerificationTarget(value: unknown): value is GcpLocalVerificationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  const keys = Object.keys(target).sort();
  return keys.join(",") === "instanceId,kind,projectId"
    && target.kind === "gcpCloudSql"
    && typeof target.projectId === "string"
    && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(target.projectId)
    && typeof target.instanceId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,97}$/.test(target.instanceId);
}

// Every durable provider mutation uses this predicate in its final SQL
// statement, after provider/lease I/O.  The member advisory lock shares the
// revocation-gate ordering, and the exact live session, member and optional
// integration generation are checked in that same database transaction.
export function providerMutationAuthoritySql(input: ProviderMutationAuthority & {
  // Refreshing the shared provider credential is a provider-integration
  // mutation, not a connection-use operation. This explicitly suppresses the
  // otherwise valid current-lease `use` authorization path.
  requireManager?: boolean;
  integration?: {
    id: string;
    provider?: string;
    generation?: bigint;
    claimId?: string | null;
  };
}) {
  const integration = input.integration;
  const lease = input.requireManager ? undefined : input.lease;
  const integrationGuard = integration ? sql`
    AND EXISTS (
      SELECT 1 FROM ${workspaceProviderIntegration} AS guarded_integration
      WHERE guarded_integration."id" = ${integration.id}::uuid
        AND guarded_integration."organization_id" = ${input.organizationId}
        ${integration.provider ? sql`AND guarded_integration."provider" = ${integration.provider}` : sql``}
        ${integration.generation !== undefined ? sql`AND guarded_integration."generation" = ${integration.generation}` : sql``}
        ${integration.claimId === undefined ? sql`` : integration.claimId === null
          ? sql`AND guarded_integration."revocation_claim_id" IS NULL`
          : sql`AND guarded_integration."revocation_claim_id" = ${integration.claimId}::uuid`}
      FOR UPDATE
    )` : sql``;
  const leaseGuard = lease ? sql`
    AND EXISTS (
      SELECT 1
      FROM ${workspaceConnection} AS lease_connection
      JOIN ${workspaceConnectionGrant} AS lease_grant
        ON lease_grant."organization_id" = lease_connection."organization_id"
       AND lease_grant."connection_id" = lease_connection."id"
       AND lease_grant."member_id" = ${input.membershipId}
       AND lease_grant."capability" IN ('use', 'manage')
      WHERE lease_connection."id" = ${lease.connectionId}::uuid
        AND lease_connection."organization_id" = ${input.organizationId}
        AND lease_connection."provider_integration_id" = ${integration?.id ?? ""}::uuid
        AND lease_connection."provider_resource_id" = ${lease.providerResourceId}::uuid
        AND lease_connection."revision" = ${lease.connectionRevision}
        AND lease_connection."credential_mode" = 'managed'
        AND lease_connection."deleted_at" IS NULL
        AND lease_connection."revocation_pending_at" IS NULL
        AND lease_connection."revocation_claim_id" IS NULL
      FOR UPDATE OF lease_connection, lease_grant
    )` : sql``;
  return sql`EXISTS (
    SELECT 1
    FROM (SELECT pg_advisory_xact_lock(hashtextextended(${revocationGateLockKey({
      kind: "member", organizationId: input.organizationId,
      memberId: input.membershipId, userId: input.userId,
    })}, 0))) AS member_lock
    JOIN ${session} AS live_session ON TRUE
    JOIN ${member} AS live_member
      ON live_member."id" = ${input.membershipId}
     AND live_member."organization_id" = ${input.organizationId}
     AND live_member."user_id" = ${input.userId}
    WHERE live_session."id" = ${input.sessionId}
      AND live_session."user_id" = ${input.userId}
      AND live_session."expires_at" > now()
      AND live_member."role" = ${input.role}
      AND live_member."role" IN (${lease ? sql`'viewer', 'analyst', 'editor', 'admin', 'owner'` : sql`'admin', 'owner'`})
      AND live_member."revocation_pending_at" IS NULL
      AND live_member."revocation_claim_id" IS NULL
      ${integrationGuard}
      ${leaseGuard}
    FOR UPDATE OF live_session, live_member
  )`;
}

export type ManagedProviderResource =
  | PlanetScaleResource
  | NeonResource
  | GcpCloudSqlResource;

export type LeaseRevocationFilter = {
  organizationId: string;
  leaseId?: string;
  userId?: string;
  connectionId?: string;
  integrationId?: string;
};

export type LeaseRevocationResult = {
  revoked: number;
  deferred: number;
};

export type ExpiredLeaseCleanupResult = LeaseRevocationResult & {
  scanned: number;
};

const CLEANUP_CLAIM_STALE_SECONDS = 2 * 60;
const CLEANUP_RETRY_BASE_MS = 60 * 1_000;
const CLEANUP_RETRY_MAX_MS = 60 * 60 * 1_000;

export function managedLeaseCleanupRetryDelayMs(attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Invalid managed lease cleanup attempt");
  }
  return Math.min(
    CLEANUP_RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 16)),
    CLEANUP_RETRY_MAX_MS,
  );
}

function isSegment(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function parsePlanetScaleResource(value: unknown): PlanetScaleResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PlanetScale resource is required");
  }
  const body = value as Record<string, unknown>;
  if (
    !isSegment(body.organization)
    || !isSegment(body.database)
    || !isSegment(body.branch)
    || (body.engine !== "postgres" && body.engine !== "mysql")
  ) {
    throw new Error("Invalid PlanetScale resource");
  }
  return {
    organization: body.organization,
    database: body.database,
    branch: body.branch,
    engine: body.engine,
  };
}

export function parseManagedProviderResource(
  provider: string,
  value: unknown,
): ManagedProviderResource {
  switch (provider) {
    case "planetScale":
      return parsePlanetScaleResource(value);
    case "neon":
      return parseNeonResource(value);
    case "gcpCloudSql":
      return parseGcpCloudSqlResource(value);
    default:
      throw new Error("Managed credential provider is not available");
  }
}

// Only a final adapter-discovered item can become an import receipt.  In
// particular, callers cannot turn a known external id into a resource object.
export function discoveredProviderResource(input: {
  provider: string;
  kind: string;
  selection: Record<string, string>;
  item: ProviderResourceItem;
}) {
  if (!allowDiscoveryImport(input.item)) return null;
  const engine = input.item.kind ?? input.selection.engine;
  let resource: ManagedProviderResource;
  if (input.provider === "planetScale" && input.kind === "branches") {
    resource = parsePlanetScaleResource({
      organization: input.selection.organization,
      database: input.selection.database,
      branch: input.item.value,
      engine,
    });
  } else if (input.provider === "neon" && input.kind === "databases") {
    resource = parseNeonResource({
      project: input.selection.project,
      branch: input.selection.branch,
      database: input.item.value,
      engine: "postgres",
    });
  } else if (input.provider === "gcpCloudSql" && input.kind === "databases") {
    resource = parseGcpCloudSqlResource({
      project: input.selection.project,
      instance: input.selection.instance,
      database: input.item.value,
      engine,
      networkMode: input.selection.networkMode || "PRIVATE_SERVICES_ACCESS",
    });
  } else {
    return null;
  }
  return providerImportProjection(input.provider as "planetScale" | "neon" | "gcpCloudSql", resource);
}

type ProviderDiscoveryReceiptRow = {
  id: string;
  expiresAt: Date | string;
};

// Neon returns timestamptz columns as strings, while some test and driver paths
// use Date. Normalize this one database boundary before a route serializes it;
// malformed driver data must not become an externally visible error payload.
function providerDiscoveryReceiptRow(
  row: ProviderDiscoveryReceiptRow | undefined,
): { id: string; expiresAt: Date } | null {
  if (
    !row
    || typeof row.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id)
  ) {
    return null;
  }
  const expiresAt = row.expiresAt instanceof Date
    ? new Date(row.expiresAt.valueOf())
    : typeof row.expiresAt === "string"
      ? new Date(row.expiresAt)
      : null;
  if (!expiresAt || Number.isNaN(expiresAt.valueOf())) return null;
  return { id: row.id, expiresAt };
}

export async function recordProviderDiscoveryReceipt(input: {
  organizationId: string;
  integrationId: string;
  memberId: string;
  userId: string;
  sessionId: string;
  role: string;
  provider: string;
  integrationGeneration: bigint;
  receiptId: string;
  expiresAt: Date;
  projection: ReturnType<typeof discoveredProviderResource>;
}) {
  if (
    !input.projection
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.receiptId)
    || Number.isNaN(input.expiresAt.valueOf())
    || input.expiresAt.valueOf() <= Date.now()
    || input.expiresAt.valueOf() > Date.now() + 5 * 60 * 1_000
  ) {
    return null;
  }
  const now = new Date();
  const result = await db.execute<ProviderDiscoveryReceiptRow>(sql`
    WITH member_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${revocationGateLockKey({
        kind: "member", organizationId: input.organizationId, memberId: input.memberId, userId: input.userId,
      })}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id" FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member ON member."id" = ${input.memberId}
        AND member."organization_id" = ${input.organizationId} AND member."user_id" = ${input.userId}
      JOIN member_lock ON TRUE
      WHERE session."id" = ${input.sessionId} AND session."user_id" = ${input.userId}
        AND session."expires_at" > now() AND member."role" = ${input.role}
        AND member."revocation_pending_at" IS NULL AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), active_integration AS MATERIALIZED (
      SELECT integration."id", integration."generation" AS "generation"
      FROM ${workspaceProviderIntegration} AS integration
      JOIN authority ON TRUE
      WHERE integration."id" = ${input.integrationId}::uuid
        AND integration."organization_id" = ${input.organizationId}
        AND integration."provider" = ${input.provider}
        AND integration."generation" = ${input.integrationGeneration}
        AND integration."status" = 'active'
        AND integration."refresh_phase" = 'idle'
        AND integration."revoked_at" IS NULL
        AND integration."revocation_pending_at" IS NULL
        AND integration."revocation_claim_id" IS NULL
      FOR UPDATE OF integration
    ), existing_receipt AS MATERIALIZED (
      SELECT receipt."id", receipt."expires_at" AS "expiresAt"
      FROM ${workspaceProviderDiscoveryReceipt} AS receipt
      JOIN ${workspaceProviderResource} AS resource
        ON resource."organization_id" = receipt."organization_id"
       AND resource."id" = receipt."resource_id"
      JOIN active_integration AS integration
        ON integration."id" = receipt."integration_id"
       AND integration."generation" = receipt."integration_generation"
      WHERE receipt."id" = ${input.receiptId}::uuid
        AND receipt."organization_id" = ${input.organizationId}
        AND receipt."integration_id" = ${input.integrationId}::uuid
        AND receipt."integration_generation" = ${input.integrationGeneration}
        AND receipt."member_id" = ${input.memberId}
        AND receipt."user_id" = ${input.userId}
        AND receipt."session_id" = ${input.sessionId}
        AND receipt."expires_at" = ${input.expiresAt}
        AND resource."provider" = ${input.provider}
        AND resource."resource_fingerprint" = ${input.projection.fingerprint}
        AND resource."resource" = ${JSON.stringify(input.projection.resource)}::jsonb
        AND resource."redacted_metadata" = ${JSON.stringify(input.projection.metadata)}::jsonb
        AND resource."capability_manifest" = ${JSON.stringify(input.projection.capabilities)}::jsonb
      FOR UPDATE OF receipt, resource
    ), canonical_resource AS MATERIALIZED (
      INSERT INTO ${workspaceProviderResource}
        ("organization_id", "provider", "resource_fingerprint", "resource",
         "redacted_metadata", "capability_manifest", "updated_at")
      SELECT ${input.organizationId}, ${input.provider}, ${input.projection.fingerprint},
        ${JSON.stringify(input.projection.resource)}::jsonb,
        ${JSON.stringify(input.projection.metadata)}::jsonb,
        ${JSON.stringify(input.projection.capabilities)}::jsonb, ${now}
      FROM active_integration
      WHERE NOT EXISTS (SELECT 1 FROM existing_receipt)
      ON CONFLICT ("organization_id", "provider", "resource_fingerprint")
      DO UPDATE SET
        "resource" = EXCLUDED."resource",
        "redacted_metadata" = EXCLUDED."redacted_metadata",
        "capability_manifest" = EXCLUDED."capability_manifest",
        "updated_at" = EXCLUDED."updated_at"
      RETURNING "id"
    ), issued AS MATERIALIZED (
      INSERT INTO ${workspaceProviderDiscoveryReceipt} AS existing
        ("id", "organization_id", "resource_id", "integration_id", "integration_generation",
         "member_id", "user_id", "session_id", "expires_at")
      SELECT ${input.receiptId}::uuid, ${input.organizationId}, resource."id", integration."id",
        integration."generation", ${input.memberId}, ${input.userId}, ${input.sessionId}, ${input.expiresAt}
      FROM canonical_resource AS resource
      JOIN active_integration AS integration ON TRUE
      ON CONFLICT ("id") DO UPDATE
      SET "expires_at" = existing."expires_at"
      WHERE existing."organization_id" = EXCLUDED."organization_id"
        AND existing."resource_id" = EXCLUDED."resource_id"
        AND existing."integration_id" = EXCLUDED."integration_id"
        AND existing."integration_generation" = EXCLUDED."integration_generation"
        AND existing."member_id" = EXCLUDED."member_id"
        AND existing."user_id" = EXCLUDED."user_id"
        AND existing."session_id" = EXCLUDED."session_id"
        AND existing."expires_at" = EXCLUDED."expires_at"
      RETURNING "id" AS "id", "expires_at" AS "expiresAt"
    )
    SELECT "id", "expiresAt" FROM existing_receipt
    UNION ALL
    SELECT "id", "expiresAt" FROM issued
    LIMIT 1
  `);
  return providerDiscoveryReceiptRow(result.rows[0]);
}

// External discovery may take seconds. Re-check the exact live principal and
// integration immediately before any names/identifiers leave this process.
export async function revalidateProviderDiscoveryAuthority(input: {
  organizationId: string; integrationId: string; provider: string; integrationGeneration: bigint;
  memberId: string; userId: string; sessionId: string; role: string;
}) {
  const result = await db.execute<{ ok: boolean }>(sql`
    WITH member_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${revocationGateLockKey({
        kind: "member", organizationId: input.organizationId, memberId: input.memberId, userId: input.userId,
      })}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id" FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member ON member."id" = ${input.memberId}
        AND member."organization_id" = ${input.organizationId} AND member."user_id" = ${input.userId}
      JOIN member_lock ON TRUE
      WHERE session."id" = ${input.sessionId} AND session."user_id" = ${input.userId}
        AND session."expires_at" > now() AND member."role" = ${input.role}
        AND member."revocation_pending_at" IS NULL AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), integration AS MATERIALIZED (
      SELECT integration."id" FROM ${workspaceProviderIntegration} integration JOIN authority ON TRUE
      WHERE integration."id" = ${input.integrationId}::uuid
        AND integration."organization_id" = ${input.organizationId} AND integration."provider" = ${input.provider}
        AND integration."generation" = ${input.integrationGeneration}
        AND integration."status" = 'active' AND integration."refresh_phase" = 'idle'
        AND integration."revoked_at" IS NULL
        AND integration."revocation_pending_at" IS NULL AND integration."revocation_claim_id" IS NULL
      FOR UPDATE OF integration
    ) SELECT EXISTS (SELECT 1 FROM integration) AS "ok"
  `);
  return result.rows[0]?.ok === true;
}

function boundedDiscoveryResults(items: ProviderResourceItem[]): ProviderResourceItem[] {
  if (items.length > MAX_PROVIDER_RESULTS) {
    throw new ProviderRequestError("provider", "Provider discovery result is too large", 409);
  }
  return items.map((item) => {
    if (
      typeof item.id !== "string" || item.id.length === 0 || item.id.length > 512
      || typeof item.name !== "string" || item.name.length === 0 || item.name.length > 512
      || typeof item.value !== "string" || item.value.length === 0 || item.value.length > 512
      || /[\u0000-\u001f\u007f]/.test(item.id)
      || /[\u0000-\u001f\u007f]/.test(item.name)
      || /[\u0000-\u001f\u007f]/.test(item.value)
      || (item.kind !== undefined && item.kind !== "postgres" && item.kind !== "mysql")
      // `unknown` is an intentional tri-state adapter value. It is preserved
      // for the UI and must never be silently lowered to a safe-looking false;
      // allowDiscoveryImport below still accepts only explicit false.
      || (item.production !== undefined
        && typeof item.production !== "boolean"
        && item.production !== "unknown")
      || (item.ready !== undefined && typeof item.ready !== "boolean")
    ) {
      throw new ProviderRequestError("provider", "Provider returned an invalid resource", 502);
    }
    // Rebuild the wire DTO so a provider SDK/runtime response cannot smuggle
    // unexpected token, password, endpoint or metadata fields into the browser.
    return {
      id: item.id,
      name: item.name,
      value: item.value,
      ...(item.kind !== undefined ? { kind: item.kind } : {}),
      ...(item.production !== undefined ? { production: item.production } : {}),
      ...(item.ready !== undefined ? { ready: item.ready } : {}),
    };
  });
}

async function providerIntegration(
  organizationId: string,
  integrationId: string,
  allowPendingRevocation: boolean,
): Promise<ActiveProviderIntegration | null> {
  const predicates = [
    eq(workspaceProviderIntegration.id, integrationId),
    eq(workspaceProviderIntegration.organizationId, organizationId),
    isNull(workspaceProviderIntegration.revokedAt),
  ];
  if (allowPendingRevocation) {
    predicates.push(inArray(workspaceProviderIntegration.status, ["active", "reconnect_required"]));
  } else {
    predicates.push(eq(workspaceProviderIntegration.status, "active"));
    predicates.push(eq(workspaceProviderIntegration.refreshPhase, "idle"));
    predicates.push(isNull(workspaceProviderIntegration.revocationPendingAt));
  }
  const row = await db.query.workspaceProviderIntegration.findFirst({
    where: and(...predicates),
    columns: {
      id: true,
      organizationId: true,
      provider: true,
      encryptedCredential: true,
      credentialExpiresAt: true,
      generation: true,
      updatedAt: true,
      localVerificationTarget: true,
    },
  });
  // The database constraint rejects this state on new deployments. Retain this
  // explicit gate for a rolling deployment where an older writer could have
  // inserted an active GCP row before the constraint became visible.
  if (
    !row
    || (row.provider === "gcpCloudSql"
      && !hasStrictGcpLocalVerificationTarget(row.localVerificationTarget))
  ) {
    return null;
  }
  return row;
}

export function activeProviderIntegration(
  organizationId: string,
  integrationId: string,
) {
  return providerIntegration(organizationId, integrationId, false);
}

export function providerIntegrationForRevocation(
  organizationId: string,
  integrationId: string,
) {
  return providerIntegration(organizationId, integrationId, true);
}

export async function providerAccessToken(
  integration: ActiveProviderIntegration,
  authority: ProviderMutationAuthority,
): Promise<string> {
  if (integration.provider !== "planetScale") {
    throw new Error("PlanetScale access token requested for another provider");
  }
  const credential = openProviderCredential<PlanetScaleToken>(
    integration.id,
    integration.encryptedCredential,
  );
  if (missingPlanetScaleManagedScopes(credential.scope).length > 0) {
    throw new PlanetScaleRequestError(
      "PlanetScale authorization is missing required managed-access scopes",
      403,
    );
  }
  const expiresAt = new Date(credential.expiresAt);
  if (
    credential.accessToken
    && credential.refreshToken
    && !Number.isNaN(expiresAt.valueOf())
    && expiresAt.valueOf() > Date.now() + 2 * 60 * 1_000
  ) {
    return credential.accessToken;
  }

  const claimId = crypto.randomUUID();
  if (!await claimPlanetScaleCredentialRefresh({
    authority, integrationId: integration.id, generation: integration.generation,
    claimId, now: new Date(),
  })) {
    throw new PlanetScaleRequestError(
      "PlanetScale authorization refresh requires a current workspace manager or reconnect",
      409,
    );
  }
  if (!await markPlanetScaleCredentialRefreshRemoteStarted({
    integrationId: integration.id,
    generation: integration.generation,
    claimId,
    now: new Date(),
  })) {
    throw new PlanetScaleRequestError(
      "PlanetScale authorization refresh requires reconnect",
      409,
    );
  }
  let refreshed: PlanetScaleToken;
  try {
    refreshed = await refreshPlanetScaleToken(credential.refreshToken, credential.scope);
  } catch (error) {
    await requirePlanetScaleCredentialReconnect({
      integrationId: integration.id, generation: integration.generation, claimId, now: new Date(),
    }).catch(() => undefined);
    throw error;
  }
  if (missingPlanetScaleManagedScopes(refreshed.scope).length > 0) {
    await requirePlanetScaleCredentialReconnect({
      integrationId: integration.id, generation: integration.generation, claimId, now: new Date(),
    }).catch(() => undefined);
    throw new PlanetScaleRequestError(
      "PlanetScale authorization lost required managed-access scopes",
      403,
    );
  }
  const encryptedCredential = sealProviderCredential(integration.id, refreshed);
  const refreshedAt = new Date();
  if (!await finalizePlanetScaleCredentialRefresh({
    authority,
    integrationId: integration.id,
    generation: integration.generation,
    claimId,
    encryptedCredential,
    credentialExpiresAt: new Date(refreshed.expiresAt),
    grantedScope: refreshed.scope,
    now: refreshedAt,
  })) {
    await requirePlanetScaleCredentialReconnect({
      integrationId: integration.id, generation: integration.generation, claimId, now: new Date(),
    }).catch(() => undefined);
    throw new PlanetScaleRequestError(
      "PlanetScale authorization refresh requires reconnect",
      409,
    );
  }
  integration.encryptedCredential = encryptedCredential;
  integration.credentialExpiresAt = new Date(refreshed.expiresAt);
  integration.generation += 1n;
  integration.updatedAt = refreshedAt;
  return refreshed.accessToken;
}

// Cleanup paths never refresh credentials without a live user authority. They
// may use an already-valid token that was decrypted server-side for the exact
// integration, otherwise the durable lease sweeper records a retry.
function currentPlanetScaleAccessToken(integration: ActiveProviderIntegration): string {
  const credential = openProviderCredential<PlanetScaleToken>(integration.id, integration.encryptedCredential);
  if (missingPlanetScaleManagedScopes(credential.scope).length > 0) {
    throw new PlanetScaleRequestError(
      "PlanetScale authorization is missing required managed-access scopes",
      403,
    );
  }
  const expiresAt = new Date(credential.expiresAt);
  if (!credential.accessToken || Number.isNaN(expiresAt.valueOf()) || expiresAt.valueOf() <= Date.now() + 2 * 60 * 1_000) {
    throw new PlanetScaleRequestError("PlanetScale credential refresh is required", 409);
  }
  return credential.accessToken;
}

function neonCredential(integration: ActiveProviderIntegration) {
  return openProviderCredential<NeonCredential>(
    integration.id,
    integration.encryptedCredential,
  );
}

function gcpCredential(integration: ActiveProviderIntegration) {
  return openProviderCredential<GcpCloudSqlCredential>(
    integration.id,
    integration.encryptedCredential,
  );
}

/** Opens the server-only envelope and returns only the exact redacted target. */
export function localGcpVerificationTarget(
  integration: Pick<ActiveProviderIntegration, "id" | "provider" | "encryptedCredential">,
): GcpLocalVerificationTarget {
  if (integration.provider !== "gcpCloudSql") {
    throw new Error("GCP verification target requested for another provider");
  }
  return projectGcpLocalVerificationTarget(
    parseGcpCloudSqlCredential(openProviderCredential<GcpCloudSqlCredential>(
      integration.id,
      integration.encryptedCredential,
    )),
  );
}

function requiredOidcToken(value: string | null | undefined) {
  if (!value) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Vercel OIDC is not available for GCP federation",
      503,
    );
  }
  return value;
}

export async function revokeProviderAuthorization(
  integration: ActiveProviderIntegration,
) {
  if (integration.provider === "planetScale") {
    const credential = openProviderCredential<PlanetScaleToken>(
      integration.id,
      integration.encryptedCredential,
    );
    // PlanetScale documents access- and refresh-token revocation separately;
    // revoking only the access token leaves a refresh token usable.
    await revokePlanetScaleAuthorization(credential.accessToken);
    await revokePlanetScaleAuthorization(credential.refreshToken);
    return;
  }
  if (integration.provider === "neon" || integration.provider === "gcpCloudSql") {
    // Neon API keys and GCP trust are customer-owned and may be shared by another
    // workspace. Disconnect scrubs our encrypted copy without deleting that trust.
    return;
  }
  throw new Error("Managed credential provider is not available");
}

export async function discoverProviderResources(input: {
  integration: ActiveProviderIntegration;
  kind: string;
  selection: Record<string, string>;
  oidcToken?: string | null;
}): Promise<ProviderResourceItem[]> {
  const { integration, kind, selection } = input;
  switch (integration.provider) {
    case "planetScale": {
      // Discovery is read-only by construction. Credential rotation remains in
      // guarded lease issuance; an expiring token asks the caller to retry after
      // that explicit mutation path instead of mutating from a GET.
      const token = currentPlanetScaleAccessToken(integration);
      if (kind === "organizations") return boundedDiscoveryResults(await listPlanetScaleOrganizations(token));
      if (kind === "databases" && isSegment(selection.organization)) {
        return boundedDiscoveryResults(await listPlanetScaleDatabases(token, selection.organization));
      }
      if (
        kind === "branches"
        && isSegment(selection.organization)
        && isSegment(selection.database)
      ) {
        const databases = await listPlanetScaleDatabases(token, selection.organization);
        const database = databases.find((item) => item.value === selection.database);
        if (!database?.kind || (selection.engine && selection.engine !== database.kind)) {
          throw new ProviderRequestError("planetScale", "PlanetScale database is no longer importable", 409);
        }
        return boundedDiscoveryResults((await listPlanetScaleBranches(
          token,
          selection.organization,
          selection.database,
        )).map((branch) => ({ ...branch, kind: database.kind })));
      }
      break;
    }
    case "neon": {
      const credential = neonCredential(integration);
      if (kind === "projects") return boundedDiscoveryResults(await listNeonProjects(credential));
      if (kind === "branches" && isSegment(selection.project)) {
        return boundedDiscoveryResults(await listNeonBranches(credential, selection.project));
      }
      if (
        kind === "databases"
        && isSegment(selection.project)
        && isSegment(selection.branch)
      ) {
        const branches = await listNeonBranches(credential, selection.project);
        const branch = branches.find((item) => item.value === selection.branch);
        if (!branch || branch.production !== false || branch.ready !== true) {
          throw new ProviderRequestError("neon", "Production provider resources cannot be imported", 409);
        }
        return boundedDiscoveryResults(await listNeonDatabases(
          credential,
          selection.project,
          selection.branch,
        )).map((item) => ({ ...item, production: false }));
      }
      break;
    }
    case "gcpCloudSql": {
      const credential = gcpCredential(integration);
      const oidcToken = requiredOidcToken(input.oidcToken);
      if (kind === "projects") return boundedDiscoveryResults(await listGcpProjects(credential));
      if (kind === "instances" && selection.project === credential.projectId) {
        return boundedDiscoveryResults(await listGcpCloudSqlInstances(credential, oidcToken));
      }
      if (
        kind === "databases"
        && selection.project === credential.projectId
        && isSegment(selection.instance)
      ) {
        const instances = await listGcpCloudSqlInstances(credential, oidcToken);
        const instance = instances.find((item) => item.value === selection.instance);
        if (!instance || instance.ready !== true || instance.production !== false || !instance.kind) {
          throw new ProviderRequestError("gcpCloudSql", "Cloud SQL instance is no longer importable", 409);
        }
        if (selection.engine && selection.engine !== instance.kind) {
          throw new ProviderRequestError("gcpCloudSql", "Cloud SQL engine does not match the selected instance", 409);
        }
        return boundedDiscoveryResults(await listGcpCloudSqlDatabases(
          credential,
          oidcToken,
          selection.instance,
          instance.kind,
        )).map((item) => ({ ...item, production: false }));
      }
      break;
    }
    default:
      throw new Error("Managed credential provider is not available");
  }
  throw new ProviderRequestError(
    integration.provider,
    "Invalid provider resource query",
    400,
  );
}

export async function validateManagedProviderResource(input: {
  integration: ActiveProviderIntegration;
  resource: ManagedProviderResource;
  oidcToken?: string | null;
}) {
  switch (input.integration.provider) {
    case "planetScale":
      return validatePlanetScaleResource(
        currentPlanetScaleAccessToken(input.integration),
        input.resource as PlanetScaleResource,
      );
    case "neon":
      return validateNeonResource(
        neonCredential(input.integration),
        input.resource as NeonResource,
      );
    case "gcpCloudSql":
      return validateGcpCloudSqlResource(
        gcpCredential(input.integration),
        requiredOidcToken(input.oidcToken),
        input.resource as GcpCloudSqlResource,
      );
    default:
      throw new Error("Managed credential provider is not available");
  }
}

async function bestEffortRevokeLease(input: {
  integration: ActiveProviderIntegration;
  resource: ManagedProviderResource;
  lease: ManagedProviderLease;
  planetScaleToken?: string;
}) {
  if (
    input.integration.provider === "planetScale"
    && (input.lease.externalCredentialKind === "role"
      || input.lease.externalCredentialKind === "password")
  ) {
    const token = input.planetScaleToken
      ?? currentPlanetScaleAccessToken(input.integration);
    await revokePlanetScaleLease(
      token,
      input.resource as PlanetScaleResource,
      input.lease.externalCredentialKind,
      input.lease.externalCredentialId,
    );
  } else if (
    input.integration.provider === "neon"
    && input.lease.externalCredentialKind === "role"
  ) {
    await revokeNeonLease(
      neonCredential(input.integration),
      input.resource as NeonResource,
      input.lease.externalCredentialId,
    );
  }
  // Cloud SQL IAM access tokens have no token-revocation API. If the one-time
  // response was not delivered, it is unreachable and expires within 15 minutes.
}

export async function issueManagedLease(input: {
  organizationId: string;
  connectionId: string;
  userId: string;
  memberId: string;
  sessionId: string;
  role: WorkspaceRoleName;
  connectionRevision: number;
  providerResourceId: string;
  engine: "postgres" | "mysql";
  accessMode: "read" | "write";
  integration: ActiveProviderIntegration;
  resource: ManagedProviderResource;
  oidcToken?: string | null;
}): Promise<ManagedProviderLease & { leaseId: string }> {
  const leaseId = crypto.randomUUID();
  const label = `dopedb-${input.userId.replace(/-/g, "").slice(0, 8)}-${
    leaseId.replace(/-/g, "").slice(0, 8)
  }`;
  const authority: ManagedLeaseAuthority = {
    leaseId,
    organizationId: input.organizationId,
    memberId: input.memberId,
    userId: input.userId,
    sessionId: input.sessionId,
    role: input.role,
    connectionId: input.connectionId,
    integrationId: input.integration.id,
    integrationGeneration: input.integration.generation,
    provider: input.integration.provider,
    connectionRevision: input.connectionRevision,
    providerResourceId: input.providerResourceId,
    engine: input.engine,
    accessMode: input.accessMode,
  };
  const reservation = await reserveManagedLeaseIfUnblocked(authority);
  if (reservation !== "reserved") {
    throw new ProviderRequestError(
      input.integration.provider,
      reservation === "limit"
        ? "Too many active database sessions. Retry after leases expire."
        : "Workspace database authority is changing. Retry shortly.",
      reservation === "limit" ? 429 : 409,
    );
  }

  let planetScaleToken: string | undefined;
  let lease: ManagedProviderLease;
  try {
    if (input.integration.provider === "neon") {
      // Sweep a small bounded batch synchronously so a delayed scheduler cannot allow
      // dormant roles to grow monotonically without adding long lease-request latency.
      const cleanup = await cleanupExpiredManagedLeases({
        integrationId: input.integration.id,
        limit: 2,
      });
      if (cleanup.deferred > 0) {
        throw new ProviderRequestError(
          "neon",
          "Expired Neon database access could not be cleaned up",
          503,
        );
      }
    }
    switch (input.integration.provider) {
      case "planetScale":
        planetScaleToken = await providerAccessToken(input.integration, {
          organizationId: input.organizationId,
          membershipId: input.memberId,
          userId: input.userId,
          sessionId: input.sessionId,
          role: input.role,
          lease: {
            connectionId: input.connectionId,
            connectionRevision: input.connectionRevision,
            providerResourceId: input.providerResourceId,
          },
        });
        // Re-read the exact canonical branch immediately before the provider
        // creates a database role/password. Discovery-time safety is never a
        // substitute for this live production/readiness check.
        await validatePlanetScaleResource(
          planetScaleToken,
          input.resource as PlanetScaleResource,
        );
        lease = await issuePlanetScaleLease(
          planetScaleToken,
          input.resource as PlanetScaleResource,
          input.accessMode,
          label,
        );
        break;
      case "neon":
        await validateNeonResource(
          neonCredential(input.integration),
          input.resource as NeonResource,
        );
        lease = await issueNeonLease({
          credential: neonCredential(input.integration),
          resource: input.resource as NeonResource,
          accessMode: input.accessMode,
          role: neonRoleForLease(input.userId, leaseId),
        });
        break;
      case "gcpCloudSql":
        await validateGcpCloudSqlResource(
          gcpCredential(input.integration),
          requiredOidcToken(input.oidcToken),
          input.resource as GcpCloudSqlResource,
        );
        lease = await issueGcpCloudSqlLease({
          credential: gcpCredential(input.integration),
          oidcToken: requiredOidcToken(input.oidcToken),
          resource: input.resource as GcpCloudSqlResource,
          accessMode: input.accessMode,
          externalCredentialId: leaseId,
        });
        break;
      default:
        throw new Error("Managed credential provider is not available");
    }
    // PlanetScale refresh rotates the durable integration generation before
    // credential creation. Finalization must bind to that exact new generation;
    // any independent reconnect/revoke after this point still fails the CAS.
    authority.integrationGeneration = input.integration.generation;
  } catch (error) {
    await db.update(workspaceCredentialLease)
      .set(input.integration.provider === "neon"
        ? { expiresAt: new Date() }
        : { revokedAt: new Date() })
      .where(eq(workspaceCredentialLease.id, leaseId))
      .catch(() => undefined);
    throw error;
  }

  try {
    if (!await finalizeManagedLeaseIfUnblocked(authority, lease)) {
      throw new Error("Managed lease reservation is no longer active");
    }
  } catch (error) {
    let revoked = false;
    try {
      await bestEffortRevokeLease({
        integration: input.integration,
        resource: input.resource,
        lease,
        planetScaleToken,
      });
      revoked = true;
    } catch {
      // Leave failed Neon cleanup visible to the durable expiry sweeper.
    }
    await db.update(workspaceCredentialLease)
      .set(input.integration.provider === "neon" && !revoked
        ? { expiresAt: new Date() }
        : { revokedAt: new Date() })
      .where(eq(workspaceCredentialLease.id, leaseId))
      .catch(() => undefined);
    throw error;
  }
  return { ...lease, leaseId };
}

type LeaseCleanupRow = {
  id: string;
  organizationId: string;
  connectionOrganizationId: string;
  connectionIntegrationId: string | null;
  integrationId: string;
  userId: string;
  provider: string;
  credentialId: string;
  credentialKind: string;
  expiresAt: Date;
  providerResource: unknown;
  cleanupClaim?: {
    attempt: number;
  };
};

export function managedLeaseAuthorityMatches(input: {
  leaseOrganizationId: string;
  connectionOrganizationId: string;
  leaseIntegrationId: string;
  connectionIntegrationId: string | null;
  integrationOrganizationId: string;
  leaseProvider: string;
  integrationProvider: string;
}) {
  return input.connectionOrganizationId === input.leaseOrganizationId
    && input.connectionIntegrationId === input.leaseIntegrationId
    && input.integrationOrganizationId === input.leaseOrganizationId
    && input.integrationProvider === input.leaseProvider;
}

async function markLeaseRevoked(
  id: string,
  cleanupClaim?: LeaseCleanupRow["cleanupClaim"],
) {
  const now = new Date();
  const cleanupFence = cleanupClaim ? sql`
      AND lease."cleanup_attempts" = ${cleanupClaim.attempt}
      AND lease."cleanup_claimed_at" IS NOT NULL` : sql``;
  // Serializing by the same connection advisory key used by revocation gates
  // ensures the second statement gets a post-lock READ COMMITTED snapshot. Two
  // workers cleaning the last two legacy leases can no longer both observe the
  // other's pre-revoke row and skip the final deterministic demotion.
  const [, result] = await db.batch([
    db.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(
        'connection:' || lease."organization_id" || ':' || lease."connection_id"::text,
        0
      ))
      FROM ${workspaceCredentialLease} AS lease
      WHERE lease."id" = ${id}::uuid
    `),
    db.execute<{ id: string }>(sql`
    WITH revoked AS (
      UPDATE ${workspaceCredentialLease} AS lease
      SET "revoked_at" = ${now}, "cleanup_claimed_at" = NULL,
          "cleanup_next_attempt_at" = NULL
      WHERE lease."id" = ${id}::uuid
        AND lease."revoked_at" IS NULL
        ${cleanupFence}
      RETURNING lease."id", lease."organization_id", lease."connection_id"
    ), demoted_legacy_connection AS (
      UPDATE ${workspaceConnection} AS connection
      SET "credential_mode" = 'member_local',
          "provider_integration_id" = NULL,
          "provider_resource" = NULL,
          "provider_resource_id" = NULL,
          "readonly_default" = TRUE,
          "allow_writes" = FALSE,
          "revision" = connection."revision" + 1,
          "updated_at" = ${now}
      FROM revoked
      WHERE connection."id" = revoked."connection_id"
        AND connection."organization_id" = revoked."organization_id"
        AND connection."credential_mode" = 'managed'
        AND connection."provider_resource_id" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceCredentialLease} AS live_lease
          WHERE live_lease."organization_id" = connection."organization_id"
            AND live_lease."connection_id" = connection."id"
            -- DML CTE siblings share a snapshot; exclude this returned row.
            AND live_lease."id" <> revoked."id"
            AND live_lease."revoked_at" IS NULL
        )
      RETURNING connection."id"
    )
    SELECT revoked."id"::text AS "id" FROM revoked
  `),
  ]);
  return result.rows.length === 1;
}

async function scheduleLeaseCleanupRetry(lease: LeaseCleanupRow) {
  const cleanupClaim = lease.cleanupClaim;
  if (!cleanupClaim) return false;
  const rows = await db.update(workspaceCredentialLease)
    .set({
      cleanupClaimedAt: null,
      cleanupNextAttemptAt: new Date(
        Date.now() + managedLeaseCleanupRetryDelayMs(cleanupClaim.attempt),
      ),
    })
    .where(and(
      eq(workspaceCredentialLease.id, lease.id),
      eq(workspaceCredentialLease.cleanupAttempts, cleanupClaim.attempt),
      isNotNull(workspaceCredentialLease.cleanupClaimedAt),
      isNull(workspaceCredentialLease.revokedAt),
    ))
    .returning({ id: workspaceCredentialLease.id });
  return rows.length === 1;
}

async function revokeLeaseRows(
  leases: LeaseCleanupRow[],
): Promise<LeaseRevocationResult> {
  if (leases.length === 0) return { revoked: 0, deferred: 0 };
  const integrationIds = [...new Set(leases.map((item) => item.integrationId))];
  const integrations = await db.select({
    id: workspaceProviderIntegration.id,
    organizationId: workspaceProviderIntegration.organizationId,
    provider: workspaceProviderIntegration.provider,
    encryptedCredential: workspaceProviderIntegration.encryptedCredential,
    credentialExpiresAt: workspaceProviderIntegration.credentialExpiresAt,
    generation: workspaceProviderIntegration.generation,
    updatedAt: workspaceProviderIntegration.updatedAt,
  }).from(workspaceProviderIntegration).where(and(
    inArray(workspaceProviderIntegration.id, integrationIds),
    inArray(workspaceProviderIntegration.status, ["active", "reconnect_required"]),
    isNull(workspaceProviderIntegration.revokedAt),
  ));
  const integrationMap = new Map(integrations.map((item) => [item.id, item]));
  const now = Date.now();
  let revoked = 0;
  let deferred = 0;

  for (const lease of leases) {
    const integration = integrationMap.get(lease.integrationId);
    const expired = lease.expiresAt.valueOf() <= now;
    try {
      if (
        !integration
        || !managedLeaseAuthorityMatches({
          leaseOrganizationId: lease.organizationId,
          connectionOrganizationId: lease.connectionOrganizationId,
          leaseIntegrationId: lease.integrationId,
          connectionIntegrationId: lease.connectionIntegrationId,
          integrationOrganizationId: integration.organizationId,
          leaseProvider: lease.provider,
          integrationProvider: integration.provider,
        })
      ) {
        throw new Error("Lease database authority is inconsistent");
      }
      if (integration.provider === "gcpCloudSql") {
        // IAM login tokens have no revocation API. Once expired they are safe to
        // retire from the audit index; live tokens remain an explicit deferral.
        if (!expired) {
          deferred += 1;
          continue;
        }
      } else if (lease.credentialKind === "pending") {
        if (!expired) {
          deferred += 1;
          continue;
        }
        if (integration.provider === "neon") {
          const resource = parseManagedProviderResource(
            integration.provider,
            lease.providerResource,
          );
          await revokeNeonLease(
            neonCredential(integration),
            resource as NeonResource,
            neonRoleForLease(lease.userId, lease.id),
          );
        }
        // Other pending records never persisted an external credential identifier.
      } else {
        const resource = parseManagedProviderResource(
          integration.provider,
          lease.providerResource,
        );
        if (
          integration.provider === "planetScale"
          && (lease.credentialKind === "role" || lease.credentialKind === "password")
        ) {
          await revokePlanetScaleLease(
            currentPlanetScaleAccessToken(integration),
            resource as PlanetScaleResource,
            lease.credentialKind,
            lease.credentialId,
          );
        } else if (
          integration.provider === "neon"
          && lease.credentialKind === "role"
        ) {
          await revokeNeonLease(
            neonCredential(integration),
            resource as NeonResource,
            lease.credentialId,
          );
        } else if (integration.provider !== "gcpCloudSql") {
          throw new Error("Lease provider is unavailable");
        }
      }
      if (await markLeaseRevoked(lease.id, lease.cleanupClaim)) revoked += 1;
    } catch (error) {
      if (error instanceof ProviderRequestError && error.status === 404) {
        if (await markLeaseRevoked(lease.id, lease.cleanupClaim)) revoked += 1;
        continue;
      }
      if (!lease.cleanupClaim || await scheduleLeaseCleanupRetry(lease)) {
        deferred += 1;
      }
    }
  }
  return { revoked, deferred };
}

export async function revokeActiveLeases(
  filter: LeaseRevocationFilter,
): Promise<LeaseRevocationResult> {
  const predicates = [
    eq(workspaceCredentialLease.organizationId, filter.organizationId),
    isNull(workspaceCredentialLease.revokedAt),
  ];
  if (filter.leaseId) {
    predicates.push(eq(workspaceCredentialLease.id, filter.leaseId));
  }
  if (filter.userId) predicates.push(eq(workspaceCredentialLease.userId, filter.userId));
  if (filter.connectionId) {
    predicates.push(eq(workspaceCredentialLease.connectionId, filter.connectionId));
  }
  if (filter.integrationId) {
    predicates.push(eq(workspaceCredentialLease.integrationId, filter.integrationId));
  }
  const leases = await db.select({
    id: workspaceCredentialLease.id,
    organizationId: workspaceCredentialLease.organizationId,
    connectionOrganizationId: workspaceConnection.organizationId,
    connectionIntegrationId: workspaceConnection.providerIntegrationId,
    integrationId: workspaceCredentialLease.integrationId,
    userId: workspaceCredentialLease.userId,
    provider: workspaceCredentialLease.provider,
    credentialId: workspaceCredentialLease.externalCredentialId,
    credentialKind: workspaceCredentialLease.externalCredentialKind,
    expiresAt: workspaceCredentialLease.expiresAt,
    providerResource: workspaceConnection.providerResource,
  }).from(workspaceCredentialLease)
    .innerJoin(
      workspaceConnection,
      eq(workspaceCredentialLease.connectionId, workspaceConnection.id),
    )
    .where(and(...predicates))
    .orderBy(asc(workspaceCredentialLease.expiresAt));
  return revokeLeaseRows(leases);
}

type ClaimedLeaseRow = {
  id: string;
  organizationId: string;
  connectionOrganizationId: string;
  connectionIntegrationId: string | null;
  integrationId: string;
  userId: string;
  provider: string;
  credentialId: string;
  credentialKind: string;
  expiresAt: Date | string;
  providerResource: unknown;
  cleanupAttempt: number | string;
};

async function claimExpiredManagedLeases(input: {
  integrationId?: string;
  limit: number;
}): Promise<LeaseCleanupRow[]> {
  const rankedIntegrationFilter = input.integrationId
    ? sql`AND ranked_lease."integration_id" = ${input.integrationId}::uuid`
    : sql``;
  const candidateIntegrationFilter = input.integrationId
    ? sql`AND lease."integration_id" = ${input.integrationId}::uuid`
    : sql``;
  const result = await db.execute<ClaimedLeaseRow>(sql`
    WITH ranked AS (
      SELECT ranked_lease."id",
             ranked_lease."cleanup_attempts",
             COALESCE(
               ranked_lease."cleanup_next_attempt_at",
               ranked_lease."expires_at"
             ) AS ready_at,
             ROW_NUMBER() OVER (
               PARTITION BY ranked_lease."organization_id"
               ORDER BY ranked_lease."cleanup_attempts" ASC,
                        COALESCE(
                          ranked_lease."cleanup_next_attempt_at",
                          ranked_lease."expires_at"
                        ) ASC,
                        ranked_lease."expires_at" ASC,
                        ranked_lease."id" ASC
             ) AS tenant_rank
      FROM ${workspaceCredentialLease} AS ranked_lease
      INNER JOIN ${workspaceConnection} AS ranked_connection
        ON ranked_connection."id" = ranked_lease."connection_id"
      WHERE ranked_lease."revoked_at" IS NULL
        AND ranked_lease."expires_at" <= CURRENT_TIMESTAMP
        AND (
          ranked_lease."cleanup_next_attempt_at" IS NULL
          OR ranked_lease."cleanup_next_attempt_at" <= CURRENT_TIMESTAMP
        )
        AND (
          ranked_lease."cleanup_claimed_at" IS NULL
          OR ranked_lease."cleanup_claimed_at"
            < CURRENT_TIMESTAMP
              - (${CLEANUP_CLAIM_STALE_SECONDS} * INTERVAL '1 second')
        )
        ${rankedIntegrationFilter}
    ),
    candidates AS (
      SELECT lease."id"
      FROM ${workspaceCredentialLease} AS lease
      INNER JOIN ranked ON ranked."id" = lease."id"
      WHERE lease."revoked_at" IS NULL
        AND lease."expires_at" <= CURRENT_TIMESTAMP
        AND (
          lease."cleanup_next_attempt_at" IS NULL
          OR lease."cleanup_next_attempt_at" <= CURRENT_TIMESTAMP
        )
        AND (
          lease."cleanup_claimed_at" IS NULL
          OR lease."cleanup_claimed_at"
            < CURRENT_TIMESTAMP
              - (${CLEANUP_CLAIM_STALE_SECONDS} * INTERVAL '1 second')
        )
        ${candidateIntegrationFilter}
      ORDER BY ranked."cleanup_attempts" ASC,
               ranked.tenant_rank ASC,
               ranked.ready_at ASC,
               lease."id" ASC
      FOR UPDATE OF lease SKIP LOCKED
      LIMIT ${input.limit}
    ),
    claimed AS (
      UPDATE ${workspaceCredentialLease} AS lease
      SET "cleanup_claimed_at" = CURRENT_TIMESTAMP,
          "cleanup_attempts" = lease."cleanup_attempts" + 1
      FROM candidates
      WHERE lease."id" = candidates."id"
      RETURNING lease."id",
                lease."organization_id",
                lease."integration_id",
                lease."user_id",
                lease."provider",
                lease."external_credential_id",
                lease."external_credential_kind",
                lease."expires_at",
                lease."connection_id",
                lease."cleanup_attempts"
    )
    SELECT claimed."id" AS "id",
           claimed."organization_id" AS "organizationId",
           connection."organization_id" AS "connectionOrganizationId",
           connection."provider_integration_id"::text AS "connectionIntegrationId",
           claimed."integration_id" AS "integrationId",
           claimed."user_id" AS "userId",
           claimed."provider" AS "provider",
           claimed."external_credential_id" AS "credentialId",
           claimed."external_credential_kind" AS "credentialKind",
           claimed."expires_at" AS "expiresAt",
           connection."provider_resource" AS "providerResource",
           claimed."cleanup_attempts" AS "cleanupAttempt"
    FROM claimed
    INNER JOIN ${workspaceConnection} AS connection
      ON connection."id" = claimed."connection_id"
    INNER JOIN ranked ON ranked."id" = claimed."id"
    ORDER BY ranked."cleanup_attempts" ASC,
             ranked.tenant_rank ASC,
             ranked.ready_at ASC,
             claimed."id" ASC
  `);
  return result.rows.map((row) => {
    const expiresAt = row.expiresAt instanceof Date
      ? row.expiresAt
      : new Date(row.expiresAt);
    const cleanupAttempt = Number(row.cleanupAttempt);
    if (
      Number.isNaN(expiresAt.valueOf())
      || !Number.isSafeInteger(cleanupAttempt)
      || cleanupAttempt < 1
    ) {
      throw new Error("Invalid managed lease cleanup claim");
    }
    return {
      id: row.id,
      organizationId: row.organizationId,
      connectionOrganizationId: row.connectionOrganizationId,
      connectionIntegrationId: row.connectionIntegrationId,
      integrationId: row.integrationId,
      userId: row.userId,
      provider: row.provider,
      credentialId: row.credentialId,
      credentialKind: row.credentialKind,
      expiresAt,
      providerResource: row.providerResource,
      cleanupClaim: { attempt: cleanupAttempt },
    };
  });
}

export async function cleanupExpiredManagedLeases(input: {
  integrationId?: string;
  limit?: number;
} = {}): Promise<ExpiredLeaseCleanupResult> {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Invalid managed lease cleanup limit");
  }
  const leases = await claimExpiredManagedLeases({
    integrationId: input.integrationId,
    limit,
  });
  return {
    scanned: leases.length,
    ...await revokeLeaseRows(leases),
  };
}
