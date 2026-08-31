// Vault managed access owns the allowlisted broker boundary, AppRole login,
// short-lived database credential issuance, verification, and revocation.

import "server-only";

import { createHash } from "node:crypto";
import { isIP } from "node:net";

import {
  BoundedJsonResponseError,
  boundedJsonResponse,
} from "../bounded-json-response";
import { env } from "../env";
import {
  ProviderRequestError,
  type ManagedAccessMode,
  type ManagedProviderLease,
} from "./provider-types";
import {
  VAULT_MAX_DATABASE_LEASE_SECONDS,
  VaultLeaseCleanupRequiredError,
  type VaultCredential,
  type VaultManagedResource,
  type VaultSession,
} from "./vault-contracts";

export {
  VAULT_MAX_DATABASE_LEASE_SECONDS,
  VaultLeaseCleanupRequiredError,
  type VaultCredential,
  type VaultManagedResource,
} from "./vault-contracts";

const VAULT_RESPONSE_LIMIT = 64 * 1_024;
const VAULT_REQUEST_TIMEOUT_MS = 8_000;
const VAULT_MIN_DATABASE_LEASE_SECONDS = 30;
const VAULT_MIN_SESSION_SECONDS = 60;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRequestError("vault", "Vault returned an invalid response", 502);
  }
  return value as JsonObject;
}

function inputObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRequestError("vault", "Invalid Vault AppRole configuration", 400);
  }
  return value as JsonObject;
}

function hasExactFields(value: JsonObject, fields: readonly string[]) {
  return Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function safeText(value: unknown, maximum: number, minimum = 1): value is string {
  return typeof value === "string"
    && value.length >= minimum
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value);
}

function safePath(value: unknown, maximum = 256): value is string {
  if (!safeText(value, maximum)) return false;
  const segments = value.split("/");
  return segments.every((segment) => (
    segment !== "."
    && segment !== ".."
    && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(segment)
  ));
}

function canonicalHost(value: unknown): string | null {
  if (!safeText(value, 253) || value !== value.trim()) return null;
  const unwrapped = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  const host = unwrapped.toLowerCase();
  if (isIP(host) === 4) return host;
  if (isIP(host) === 6) {
    const normalized = new URL(`https://[${host}]`).hostname;
    return normalized.slice(1, -1);
  }
  const labels = host.split(".");
  if (labels.some((label) => (
    label.length === 0
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  ))) {
    return null;
  }
  return host;
}

function encodedPath(value: string) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function allowedVaultOrigin(value: unknown) {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    return null;
  }
  return env.vaultBrokerOrigins().includes(url.origin) ? url.origin : null;
}

function exactTemplateCount(value: string, template: string) {
  return value.split(template).length - 1;
}

function decodedDatabase(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    return safeText(decoded, 512) && !decoded.includes("/") ? decoded : null;
  } catch {
    return null;
  }
}

function postgresConnectionTarget(connectionUrl: string) {
  if (
    exactTemplateCount(connectionUrl, "{{username}}") !== 1
    || exactTemplateCount(connectionUrl, "{{password}}") !== 1
    || connectionUrl.includes(",")
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(connectionUrl
      .replace("{{username}}", "dopedb-vault-user")
      .replace("{{password}}", "dopedb-vault-password"));
  } catch {
    return null;
  }
  const host = canonicalHost(url.hostname);
  const port = url.port ? Number(url.port) : 5432;
  const database = decodedDatabase(url.pathname.slice(1));
  const sslModes = url.searchParams.getAll("sslmode");
  const forbiddenOverrides = [
    "host",
    "hostaddr",
    "port",
    "dbname",
    "database",
    "user",
    "password",
    "service",
  ];
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    || url.username !== "dopedb-vault-user"
    || url.password !== "dopedb-vault-password"
    || !host
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || !database
    || url.hash
    || sslModes.length !== 1
    || sslModes[0] !== "verify-full"
    || forbiddenOverrides.some((key) => url.searchParams.has(key))
  ) {
    return null;
  }
  return { host, port, database };
}

function mysqlConnectionTarget(connectionUrl: string) {
  if (
    exactTemplateCount(connectionUrl, "{{username}}") !== 1
    || exactTemplateCount(connectionUrl, "{{password}}") !== 1
  ) {
    return null;
  }
  const match = /^\{\{username\}\}:\{\{password\}\}@tcp\(([^)]+)\)\/([^?]+)(?:\?(.*))?$/.exec(
    connectionUrl,
  );
  if (!match) return null;
  let url: URL;
  try {
    url = new URL(`mysql://dopedb-vault-user:dopedb-vault-password@${match[1]}/`);
  } catch {
    return null;
  }
  const host = canonicalHost(url.hostname);
  const port = url.port ? Number(url.port) : 3306;
  const database = decodedDatabase(match[2]);
  const parameters = new URLSearchParams(match[3] ?? "");
  const tlsModes = parameters.getAll("tls");
  if (
    url.username !== "dopedb-vault-user"
    || url.password !== "dopedb-vault-password"
    || !host
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || !database
    || tlsModes.length !== 1
    || tlsModes[0] !== "true"
    || parameters.has("allowFallbackToPlaintext")
  ) {
    return null;
  }
  return { host, port, database };
}

export function parseVaultCredential(value: unknown): VaultCredential {
  const body = inputObject(value);
  const target = inputObject(body.target);
  const host = canonicalHost(target.host);
  const fields = [
    "kind",
    "schemaVersion",
    "address",
    "namespace",
    "authMount",
    "roleId",
    "secretId",
    "databaseMount",
    "databaseConnection",
    "readRole",
    "writeRole",
    "target",
  ] as const;
  const targetFields = [
    "host",
    "port",
    "database",
    "engine",
    "sslmode",
    "production",
  ] as const;
  const address = allowedVaultOrigin(body.address);
  if (
    !hasExactFields(body, fields)
    || !hasExactFields(target, targetFields)
    || body.kind !== "appRole"
    || body.schemaVersion !== 1
    || !address
    || (body.namespace !== null && !safePath(body.namespace, 256))
    || !safePath(body.authMount, 128)
    || !safeText(body.roleId, 2_048, 8)
    || !safeText(body.secretId, 2_048, 8)
    || !safePath(body.databaseMount, 128)
    || !safePath(body.databaseConnection, 128)
    || !safePath(body.readRole, 128)
    || (body.writeRole !== null && !safePath(body.writeRole, 128))
    || body.writeRole === body.readRole
    || !host
    || !Number.isInteger(target.port)
    || (target.port as number) < 1
    || (target.port as number) > 65_535
    || !safeText(target.database, 512)
    || (target.engine !== "postgres" && target.engine !== "mysql")
    || target.sslmode !== "verify-full"
    || typeof target.production !== "boolean"
  ) {
    throw new ProviderRequestError("vault", "Invalid Vault AppRole configuration", 400);
  }
  return {
    kind: "appRole",
    schemaVersion: 1,
    address,
    namespace: body.namespace,
    authMount: body.authMount,
    roleId: body.roleId,
    secretId: body.secretId,
    databaseMount: body.databaseMount,
    databaseConnection: body.databaseConnection,
    readRole: body.readRole,
    writeRole: body.writeRole,
    target: {
      host,
      port: target.port,
      database: target.database,
      engine: target.engine,
      sslmode: target.sslmode,
      production: target.production,
    },
  } as VaultCredential;
}

export function vaultIntegrationIdentity(credential: VaultCredential) {
  const stable = [
    credential.target.engine,
    credential.target.host,
    credential.target.port.toString(),
    credential.target.database,
  ].join("\n");
  const fingerprint = createHash("sha256").update(stable, "utf8").digest("hex");
  const hostname = new URL(credential.address).hostname;
  return {
    externalAccountId: fingerprint,
    displayName: `Vault · ${hostname} / ${credential.target.database}`,
    grantedScope: [
      credential.writeRole
        ? "database.dynamic.read database.dynamic.write ttl<=900"
        : "database.dynamic.read ttl<=900",
      `policy:${vaultPolicyFingerprint(credential)}`,
    ].join(" "),
  };
}

export function vaultPolicyFingerprint(credential: VaultCredential) {
  return createHash("sha256").update([
    credential.address,
    credential.namespace ?? "",
    credential.authMount,
    credential.databaseMount,
    credential.databaseConnection,
    credential.readRole,
    credential.writeRole ?? "",
    credential.target.engine,
    credential.target.host,
    credential.target.port.toString(),
    credential.target.database,
    credential.target.sslmode,
    credential.target.production ? "production" : "non-production",
  ].join("\n"), "utf8").digest("hex");
}

export function vaultManagedResource(credential: VaultCredential): VaultManagedResource {
  return {
    targetFingerprint: vaultIntegrationIdentity(credential).externalAccountId,
    databaseMount: credential.databaseMount,
    databaseConnection: credential.databaseConnection,
    readRole: credential.readRole,
    writeRole: credential.writeRole,
    host: credential.target.host,
    port: credential.target.port,
    database: credential.target.database,
    engine: credential.target.engine,
    sslmode: credential.target.sslmode,
  };
}

export function parseVaultManagedResource(value: unknown): VaultManagedResource {
  const body = object(value);
  const host = canonicalHost(body.host);
  const fields = [
    "targetFingerprint",
    "databaseMount",
    "databaseConnection",
    "readRole",
    "writeRole",
    "host",
    "port",
    "database",
    "engine",
    "sslmode",
  ];
  if (
    Object.keys(body).length !== fields.length
    || fields.some((field) => !Object.hasOwn(body, field))
    || typeof body.targetFingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(body.targetFingerprint)
    || !safePath(body.databaseMount, 128)
    || !safePath(body.databaseConnection, 128)
    || !safePath(body.readRole, 128)
    || (body.writeRole !== null && !safePath(body.writeRole, 128))
    || body.writeRole === body.readRole
    || !host
    || body.host !== host
    || !Number.isInteger(body.port)
    || (body.port as number) < 1
    || (body.port as number) > 65_535
    || !safeText(body.database, 512)
    || (body.engine !== "postgres" && body.engine !== "mysql")
    || body.sslmode !== "verify-full"
  ) {
    throw new ProviderRequestError("vault", "Invalid Vault database resource", 409);
  }
  return body as VaultManagedResource;
}

async function vaultJson(
  credential: VaultCredential,
  path: string,
  init: RequestInit = {},
  token?: string,
) {
  const response = await fetch(`${credential.address}/v1/${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(credential.namespace
        ? { "x-vault-namespace": credential.namespace }
        : {}),
      ...(token ? { "x-vault-token": token } : {}),
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(VAULT_REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new ProviderRequestError("vault", "Vault is unavailable", 502);
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const status = response.status === 401 || response.status === 403
      ? 424
      : response.status === 404
        ? 404
        : response.status >= 500
          ? 502
          : 409;
    throw new ProviderRequestError("vault", "Vault rejected the request", status);
  }
  if (response.status === 204) return null;
  try {
    return await boundedJsonResponse(response, VAULT_RESPONSE_LIMIT);
  } catch (error) {
    if (error instanceof BoundedJsonResponseError && error.failure === "oversized") {
      throw new ProviderRequestError("vault", "Vault response is too large", 502);
    }
    throw new ProviderRequestError("vault", "Vault returned an invalid response", 502);
  }
}

async function vaultLogin(credential: VaultCredential): Promise<VaultSession> {
  const response = object(await vaultJson(
    credential,
    `auth/${encodedPath(credential.authMount)}/login`,
    {
      method: "POST",
      body: JSON.stringify({
        role_id: credential.roleId,
        secret_id: credential.secretId,
      }),
    },
  ));
  const auth = object(response.auth);
  const policies = auth.token_policies;
  if (
    !safeText(auth.client_token, 16 * 1_024)
    || /\s/.test(auth.client_token)
    || !Number.isInteger(auth.lease_duration)
    || (auth.lease_duration as number) < VAULT_MIN_SESSION_SECONDS
    || (auth.lease_duration as number) > VAULT_MAX_DATABASE_LEASE_SECONDS
    || auth.token_type !== "service"
    || !Array.isArray(policies)
    || policies.length < 1
    || policies.length > 32
    || !policies.every((policy) => safePath(policy, 128))
    || policies.includes("root")
    || !safeText(response.request_id, 512)
  ) {
    throw new ProviderRequestError("vault", "Vault AppRole token is unsafe", 502);
  }
  return {
    token: auth.client_token,
    providerAuditId: response.request_id,
    expiresAtMs: Date.now() + (auth.lease_duration as number) * 1_000,
  };
}

async function verifyVaultRole(
  credential: VaultCredential,
  token: string,
  role: string,
) {
  const response = object(await vaultJson(
    credential,
    `${encodedPath(credential.databaseMount)}/roles/${encodedPath(role)}`,
    {},
    token,
  ));
  const data = object(response.data);
  if (
    !Number.isInteger(data.default_ttl)
    || !Number.isInteger(data.max_ttl)
    || (data.default_ttl as number) < VAULT_MIN_DATABASE_LEASE_SECONDS
    || (data.default_ttl as number) > VAULT_MAX_DATABASE_LEASE_SECONDS
    || (data.max_ttl as number) < VAULT_MIN_DATABASE_LEASE_SECONDS
    || (data.max_ttl as number) > VAULT_MAX_DATABASE_LEASE_SECONDS
    || data.db_name !== credential.databaseConnection
    || data.credential_type !== "password"
    || !safeText(response.request_id, 512)
  ) {
    throw new ProviderRequestError(
      "vault",
      "Vault database role must enforce a 30 second to 15 minute TTL",
      409,
    );
  }
  return response.request_id as string;
}

async function verifyVaultDatabaseConnection(
  credential: VaultCredential,
  token: string,
) {
  const response = object(await vaultJson(
    credential,
    `${encodedPath(credential.databaseMount)}/config/${encodedPath(
      credential.databaseConnection,
    )}`,
    {},
    token,
  ));
  const data = object(response.data);
  const connectionDetails = object(data.connection_details);
  const allowedRoles = data.allowed_roles;
  const expectedRoles = [
    credential.readRole,
    ...(credential.writeRole ? [credential.writeRole] : []),
  ];
  const expectedPlugin = credential.target.engine === "postgres"
    ? "postgresql-database-plugin"
    : "mysql-database-plugin";
  const connectionUrl = connectionDetails.connection_url;
  const target = safeText(connectionUrl, 8 * 1_024)
    ? credential.target.engine === "postgres"
      ? postgresConnectionTarget(connectionUrl)
      : mysqlConnectionTarget(connectionUrl)
    : null;
  if (
    data.plugin_name !== expectedPlugin
    || !Array.isArray(allowedRoles)
    || allowedRoles.length < 1
    || allowedRoles.length > 64
    || !allowedRoles.every((role) => safePath(role, 128))
    || new Set(allowedRoles).size !== allowedRoles.length
    || !expectedRoles.every((role) => allowedRoles.includes(role))
    || !target
    || target.host !== credential.target.host
    || target.port !== credential.target.port
    || target.database !== credential.target.database
    || !safeText(response.request_id, 512)
  ) {
    throw new ProviderRequestError(
      "vault",
      "Vault database connection must match the exact TLS-verified target and roles",
      409,
    );
  }
  return response.request_id as string;
}

async function revokeVaultLeaseWithToken(
  credential: VaultCredential,
  token: string,
  leaseId: string,
) {
  if (!safeText(leaseId, 2_048)) {
    throw new ProviderRequestError("vault", "Vault returned an invalid lease id", 502);
  }
  await vaultJson(
    credential,
    "sys/leases/revoke",
    {
      method: "POST",
      body: JSON.stringify({ lease_id: leaseId, sync: true }),
    },
    token,
  );
}

async function revokeVaultToken(
  credential: VaultCredential,
  token: string,
) {
  await vaultJson(
    credential,
    "auth/token/revoke-self",
    { method: "POST" },
    token,
  );
}

async function issueVaultLeaseWithToken(
  credential: VaultCredential,
  resource: VaultManagedResource,
  accessMode: ManagedAccessMode,
  session: VaultSession,
): Promise<ManagedProviderLease & { providerAuditId: string }> {
  if (accessMode === "schema") {
    throw new ProviderRequestError(
      "vault",
      "Vault schema access requires a separately verified dynamic role",
      409,
    );
  }
  const role = accessMode === "write" ? resource.writeRole : resource.readRole;
  if (!role) {
    throw new ProviderRequestError("vault", "Vault write access is not configured", 403);
  }
  const response = object(await vaultJson(
    credential,
    `${encodedPath(resource.databaseMount)}/creds/${encodedPath(role)}`,
    {},
    session.token,
  ));
  const data = object(response.data);
  const leaseId = response.lease_id;
  const leaseDuration = response.lease_duration;
  const issuedAtMs = Date.now();
  const effectiveExpiresAtMs = Number.isInteger(leaseDuration)
    ? Math.min(
        issuedAtMs + (leaseDuration as number) * 1_000,
        session.expiresAtMs,
      )
    : 0;
  const valid = safeText(leaseId, 2_048)
    && Number.isInteger(leaseDuration)
    && (leaseDuration as number) >= VAULT_MIN_DATABASE_LEASE_SECONDS
    && (leaseDuration as number) <= VAULT_MAX_DATABASE_LEASE_SECONDS
    && effectiveExpiresAtMs - issuedAtMs >= VAULT_MIN_DATABASE_LEASE_SECONDS * 1_000
    && safeText(data.username, 512)
    && safeText(data.password, 64 * 1_024)
    && safeText(response.request_id, 512);
  if (!valid) {
    if (safeText(leaseId, 2_048)) {
      try {
        await revokeVaultLeaseWithToken(credential, session.token, leaseId);
      } catch {
        throw new VaultLeaseCleanupRequiredError(
          leaseId,
          safeText(response.request_id, 512)
            ? response.request_id
            : "vault-invalid-response",
        );
      }
    }
    throw new ProviderRequestError(
      "vault",
      "Vault returned unsafe database credentials or lease duration",
      502,
    );
  }
  return {
    externalCredentialId: leaseId,
    externalCredentialKind: "role",
    host: resource.host,
    port: resource.port,
    database: resource.database,
    username: data.username as string,
    password: data.password as string,
    sslmode: resource.sslmode,
    // Vault associates a dynamic secret with the token that requested it. The
    // credential is therefore valid only until the earlier of the secret lease
    // and AppRole token expiries. Desktop retires its pool another 30 seconds early.
    expiresAt: new Date(effectiveExpiresAtMs).toISOString(),
    providerAuditId: response.request_id as string,
  };
}

function assertVaultResourceMatches(
  credential: VaultCredential,
  resource: VaultManagedResource,
) {
  const expected = vaultManagedResource(credential);
  if (
    expected.targetFingerprint !== resource.targetFingerprint
    || expected.databaseMount !== resource.databaseMount
    || expected.databaseConnection !== resource.databaseConnection
    || expected.readRole !== resource.readRole
    || expected.writeRole !== resource.writeRole
    || expected.host !== resource.host
    || expected.port !== resource.port
    || expected.database !== resource.database
    || expected.engine !== resource.engine
    || expected.sslmode !== resource.sslmode
  ) {
    throw new ProviderRequestError(
      "vault",
      "Vault database target changed; reconnect the broker",
      409,
    );
  }
}

export async function verifyVaultCredential(credential: VaultCredential) {
  const resource = vaultManagedResource(credential);
  const session = await vaultLogin(credential);
  try {
    await verifyVaultDatabaseConnection(credential, session.token);
    await verifyVaultRole(credential, session.token, resource.readRole);
    const readLease = await issueVaultLeaseWithToken(
      credential,
      resource,
      "read",
      session,
    );
    await revokeVaultLeaseWithToken(
      credential,
      session.token,
      readLease.externalCredentialId,
    );
    if (resource.writeRole) {
      await verifyVaultRole(credential, session.token, resource.writeRole);
      const writeLease = await issueVaultLeaseWithToken(
        credential,
        resource,
        "write",
        session,
      );
      await revokeVaultLeaseWithToken(
        credential,
        session.token,
        writeLease.externalCredentialId,
      );
    }
  } finally {
    await revokeVaultToken(credential, session.token).catch(() => undefined);
  }
  return {
    ...vaultIntegrationIdentity(credential),
    providerAuditId: session.providerAuditId,
  };
}

export async function issueVaultLease(input: {
  credential: VaultCredential;
  resource: VaultManagedResource;
  accessMode: ManagedAccessMode;
}) {
  if (input.accessMode === "schema") {
    throw new ProviderRequestError(
      "vault",
      "Vault schema access requires a separately verified dynamic role",
      409,
    );
  }
  assertVaultResourceMatches(input.credential, input.resource);
  const session = await vaultLogin(input.credential);
  try {
    const role = input.accessMode === "write"
      ? input.resource.writeRole
      : input.resource.readRole;
    if (!role) {
      throw new ProviderRequestError("vault", "Vault write access is not configured", 403);
    }
    await verifyVaultDatabaseConnection(input.credential, session.token);
    await verifyVaultRole(input.credential, session.token, role);
    return await issueVaultLeaseWithToken(
      input.credential,
      input.resource,
      input.accessMode,
      session,
    );
  } catch (error) {
    const tokenRevoked = await revokeVaultToken(
      input.credential,
      session.token,
    ).then(() => true).catch(() => false);
    if (error instanceof VaultLeaseCleanupRequiredError && tokenRevoked) {
      // Revoking the issuing token also revokes every dynamic secret generated
      // with it, so no durable cleanup record is needed in this exact case.
      throw new ProviderRequestError(
        "vault",
        "Vault returned unsafe database credentials or lease duration",
        502,
      );
    }
    throw error;
  }
}

export async function revokeVaultLease(
  credential: VaultCredential,
  leaseId: string,
) {
  const session = await vaultLogin(credential);
  try {
    await revokeVaultLeaseWithToken(credential, session.token, leaseId);
  } finally {
    await revokeVaultToken(credential, session.token).catch(() => undefined);
  }
}
