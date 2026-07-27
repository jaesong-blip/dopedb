import "server-only";

import { eq } from "drizzle-orm";

import { db } from "../db";
import { workspaceCredentialLease } from "../schema";
import {
  issuePlanetScaleLease,
  revokePlanetScaleLease,
  validatePlanetScaleResource,
  type PlanetScaleResource,
} from "../providers/planetscale";
import {
  issueNeonLease,
  neonRoleForLease,
  revokeNeonLease,
  validateNeonResource,
} from "../providers/neon";
import type { NeonResource } from "../providers/neon-core";
import {
  issueGcpCloudSqlLease,
  validateGcpCloudSqlResource,
} from "../providers/gcp-cloud-sql";
import type { GcpCloudSqlResource } from "../providers/gcp-cloud-sql-core";
import {
  ProviderRequestError,
  type ManagedProviderLease,
} from "../providers/provider-types";
import {
  finalizeManagedLeaseIfUnblocked,
  reserveManagedLeaseIfUnblocked,
  type ManagedLeaseAuthority,
} from "../revocation-gates";
import type { WorkspaceRoleName } from "../workspace-permissions";
import type { ActiveProviderIntegration } from "./authority";
import type { ManagedProviderResource } from "./domain";
import {
  currentPlanetScaleAccessToken,
  gcpCredential,
  neonCredential,
  providerAccessToken,
  requiredOidcToken,
} from "./integration";
import { cleanupExpiredManagedLeases } from "./lease-cleanup";

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
