import "server-only";

import { MAX_PROVIDER_RESULTS } from "../providers/adapter-contract";
import { openProviderCredential, sealProviderCredential } from "../secret-envelope";
import {
  claimPlanetScaleCredentialRefresh,
  finalizePlanetScaleCredentialRefresh,
  markPlanetScaleCredentialRefreshRemoteStarted,
  requirePlanetScaleCredentialReconnect,
} from "../provider-integration-mutation-store";
import {
  listPlanetScaleBranches,
  listPlanetScaleDatabases,
  listPlanetScaleOrganizations,
  PlanetScaleRequestError,
  refreshPlanetScaleToken,
  revokePlanetScaleAuthorization,
  type PlanetScaleToken,
} from "../providers/planetscale";
import { missingPlanetScaleManagedScopes } from "../providers/planetscale-core";
import {
  inspectNeonCredential,
  listNeonBranches,
  listNeonDatabases,
  listNeonProjects,
} from "../providers/neon";
import { parseNeonCredential } from "../providers/neon-core";
import {
  listGcpCloudSqlDatabases,
  listGcpCloudSqlInstances,
  listGcpProjects,
} from "../providers/gcp-cloud-sql";
import {
  gcpLocalVerificationTarget as projectGcpLocalVerificationTarget,
  parseGcpCloudSqlCredential,
  type GcpCloudSqlCredential,
  type GcpLocalVerificationTarget,
} from "../providers/gcp-cloud-sql-core";
import {
  ProviderRequestError,
  type ProviderResourceItem,
} from "../providers/provider-types";
import {
  type ActiveProviderIntegration,
  type ProviderMutationAuthority,
} from "./authority";
import { isSegment } from "./domain";

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
      || (item.safeMigrations !== undefined && typeof item.safeMigrations !== "boolean")
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
      ...(item.safeMigrations !== undefined
        ? { safeMigrations: item.safeMigrations }
        : {}),
    };
  });
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
export function currentPlanetScaleAccessToken(integration: ActiveProviderIntegration): string {
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

export function neonCredential(integration: ActiveProviderIntegration) {
  return parseNeonCredential(openProviderCredential<unknown>(
    integration.id,
    integration.encryptedCredential,
  ));
}

export async function verifiedNeonCredential(
  integration: ActiveProviderIntegration,
) {
  if (integration.provider !== "neon") {
    throw new Error("Neon credential requested for another provider");
  }
  const credential = neonCredential(integration);
  const auth = await inspectNeonCredential(credential);
  if (auth.externalAccountId !== integration.externalAccountId) {
    throw new ProviderRequestError(
      "neon",
      "Neon API key identity or project scope changed; reconnect the account",
      409,
    );
  }
  return credential;
}

export function gcpCredential(integration: ActiveProviderIntegration) {
  return parseGcpCloudSqlCredential(
    openProviderCredential<GcpCloudSqlCredential>(
      integration.id,
      integration.encryptedCredential,
    ),
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

export function requiredOidcToken(value: string | null | undefined) {
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
          database.kind,
        )).map((branch) => ({ ...branch, kind: database.kind })));
      }
      break;
    }
    case "neon": {
      const credential = await verifiedNeonCredential(integration);
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
        if (!branch || branch.ready !== true) {
          throw new ProviderRequestError("neon", "Neon branch is not ready", 409);
        }
        return boundedDiscoveryResults(await listNeonDatabases(
          credential,
          selection.project,
          selection.branch,
        )).map((item) => ({ ...item, production: branch.production }));
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
        if (
          !instance
          || instance.ready !== true
          || (
            instance.production !== false
            && instance.production !== true
          )
          || !instance.kind
        ) {
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
        )).map((item) => ({ ...item, production: instance.production }));
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
