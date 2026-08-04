// PlanetScale's OAuth and database credential API adapter. Provider responses are
// narrowed immediately so tokens and one-time passwords never enter logs or storage.
import "server-only";

import { env } from "../env";
import { MAX_PROVIDER_RESULTS } from "./adapter-contract";
import { planetScaleEngine } from "./planetscale-core";
import {
  ProviderRequestError,
  type ManagedProviderLease,
  type ProviderResourceItem,
} from "./provider-types";

const AUTH_ORIGIN = "https://auth.planetscale.com";
const API_ORIGIN = "https://api.planetscale.com";
const REQUEST_TIMEOUT_MS = 15_000;
export const PLANETSCALE_LEASE_SECONDS = 15 * 60;

type JsonObject = Record<string, unknown>;

export type PlanetScaleToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
};

export type PlanetScaleTokenInfo = {
  subject: string;
  scope: string;
  expiresAt: string;
};

export type PlanetScaleResource = {
  organization: string;
  database: string;
  branch: string;
  engine: "postgres" | "mysql";
};

export type PlanetScaleLease = ManagedProviderLease & {
  externalCredentialKind: "role" | "password";
  sslmode: "verify-full";
};

export class PlanetScaleRequestError extends ProviderRequestError {
  constructor(
    message: string,
    status: number,
  ) {
    super("planetScale", message, status);
    this.name = "PlanetScaleRequestError";
  }
}

/**
 * A provider credential was created, its one-time response failed validation,
 * and the immediate provider DELETE also failed. The identifier is not a
 * secret; callers must persist it only in the existing cleanup queue and never
 * attempt to deliver the malformed credential.
 */
export class PlanetScaleLeaseCleanupRequiredError extends PlanetScaleRequestError {
  constructor(
    readonly externalCredentialKind: "role" | "password",
    readonly externalCredentialId: string,
  ) {
    super("PlanetScale credential cleanup is pending", 503);
    this.name = "PlanetScaleLeaseCleanupRequiredError";
  }
}

function credentials() {
  const clientId = env.planetScaleClientId();
  const clientSecret = env.planetScaleClientSecret();
  if (!clientId || !clientSecret) {
    throw new PlanetScaleRequestError("PlanetScale integration is not configured", 503);
  }
  return { clientId, clientSecret };
}

export function isPlanetScaleConfigured() {
  return Boolean(env.planetScaleClientId() && env.planetScaleClientSecret());
}

export function planetScaleRedirectUri() {
  return `${env.appOrigin()}/api/v1/providers/planet-scale/callback`;
}

export function planetScaleAuthorizationUrl(state: string) {
  const { clientId } = credentials();
  const url = new URL("/oauth/authorize", AUTH_ORIGIN);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", planetScaleRedirectUri());
  url.searchParams.set("state", state);
  return url.toString();
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlanetScaleRequestError("PlanetScale returned an invalid response", 502);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PlanetScaleRequestError(`PlanetScale response omitted ${field}`, 502);
  }
  return value;
}

function parseExpiresAt(value: unknown, requestedSeconds: number): string {
  if (typeof value !== "string") {
    throw new PlanetScaleRequestError("PlanetScale omitted credential expiry", 502);
  }
  const parsed = new Date(value);
  const remainingMs = parsed.valueOf() - Date.now();
  if (
    Number.isNaN(parsed.valueOf())
    || remainingMs < 30_000
    || remainingMs > (requestedSeconds + 60) * 1_000
  ) {
    throw new PlanetScaleRequestError("PlanetScale returned an invalid credential expiry", 502);
  }
  return parsed.toISOString();
}

async function responseJson(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // Provider bodies can contain request details. Keep only the status class.
    const status = response.status >= 500 ? 502 : response.status;
    throw new PlanetScaleRequestError("PlanetScale rejected the request", status);
  }
  return body;
}

async function oauthTokenRequest(
  parameters: URLSearchParams,
  previousRefreshToken?: string,
  previousScope = "",
): Promise<PlanetScaleToken> {
  const response = await fetch(`${AUTH_ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: parameters,
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error) => {
    if (error instanceof PlanetScaleRequestError) throw error;
    throw new PlanetScaleRequestError("PlanetScale authorization is unavailable", 502);
  });
  const body = object(await responseJson(response));
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0
    ? Math.min(body.expires_in, 60 * 60 * 24 * 31)
    : 60 * 60;
  return {
    accessToken: requiredString(body.access_token, "access_token"),
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : requiredString(previousRefreshToken, "refresh_token"),
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
    scope: typeof body.scope === "string" ? body.scope : previousScope,
  };
}

export async function exchangePlanetScaleCode(code: string): Promise<PlanetScaleToken> {
  const { clientId, clientSecret } = credentials();
  return oauthTokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: planetScaleRedirectUri(),
    client_id: clientId,
    client_secret: clientSecret,
  }));
}

export async function refreshPlanetScaleToken(
  refreshToken: string,
  previousScope = "",
): Promise<PlanetScaleToken> {
  const { clientId, clientSecret } = credentials();
  return oauthTokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }), refreshToken, previousScope);
}

export async function inspectPlanetScaleToken(
  accessToken: string,
): Promise<PlanetScaleTokenInfo> {
  const response = await fetch(`${AUTH_ORIGIN}/oauth/token/info`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new PlanetScaleRequestError("PlanetScale authorization is unavailable", 502);
  });
  const body = object(await responseJson(response));
  if (body.active !== true) {
    throw new PlanetScaleRequestError("PlanetScale authorization is inactive", 401);
  }
  const exp = typeof body.exp === "number" ? body.exp * 1_000 : Date.now() + 60 * 60 * 1_000;
  return {
    subject: requiredString(body.sub, "subject"),
    scope: typeof body.scope === "string" ? body.scope : "",
    expiresAt: new Date(exp).toISOString(),
  };
}

async function apiRequest(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new PlanetScaleRequestError("PlanetScale API is unavailable", 502);
  });
  if (response.status === 204) return null;
  return responseJson(response);
}

function segment(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new PlanetScaleRequestError("Invalid PlanetScale resource identifier", 400);
  }
  return encodeURIComponent(value);
}

async function paginated(
  accessToken: string,
  path: string,
): Promise<JsonObject[]> {
  const rows: JsonObject[] = [];
  const pageSize = 100;
  const maxPages = Math.ceil(MAX_PROVIDER_RESULTS / pageSize);
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const body = object(await apiRequest(
      accessToken,
      `${path}${separator}per_page=${pageSize}&page=${page}`,
    ));
    const data = Array.isArray(body.data) ? body.data : [];
    if (data.length > MAX_PROVIDER_RESULTS - rows.length) {
      throw new PlanetScaleRequestError("PlanetScale discovery scope is too large", 409);
    }
    rows.push(...data.map(object));
    const hasNextPage = typeof body.next_page === "number";
    if (hasNextPage && page === maxPages) {
      throw new PlanetScaleRequestError("PlanetScale discovery scope is too large", 409);
    }
    if (!hasNextPage) break;
  }
  return rows;
}

function resourceItem(
  row: JsonObject,
  options: {
    includeKind?: boolean;
    includeBranch?: boolean;
    branchEngine?: "postgres" | "mysql";
  } = {},
): ProviderResourceItem {
  const name = requiredString(row.name ?? row.slug, "resource name");
  const kind = options.includeKind ? planetScaleEngine(row.kind) ?? undefined : undefined;
  return {
    id: typeof row.id === "string" ? row.id : name,
    name,
    value: name,
    ...(kind ? { kind } : {}),
    ...(options.includeBranch ? {
      production: row.production === true
        ? true
        : row.production === false
          ? false
          : "unknown" as const,
      // PlanetScale's official MySQL branch model exposes `ready`; its
      // PostgreSQL model additionally exposes `state`. Neither model exposes a
      // `schema_ready` field, so requiring it would make every branch unusable.
      ready: row.ready === true
        && (options.branchEngine !== "postgres" || row.state === "ready"),
      ...(typeof row.safe_migrations === "boolean"
        ? { safeMigrations: row.safe_migrations }
        : {}),
    } : {}),
  };
}

export async function listPlanetScaleOrganizations(accessToken: string) {
  const rows = await paginated(accessToken, "/v1/organizations");
  return rows.map((row) => resourceItem(row));
}

export async function listPlanetScaleDatabases(
  accessToken: string,
  organization: string,
) {
  const rows = await paginated(
    accessToken,
    `/v1/organizations/${segment(organization)}/databases`,
  );
  return rows.map((row) => resourceItem(row, { includeKind: true }));
}

export async function listPlanetScaleBranches(
  accessToken: string,
  organization: string,
  database: string,
  engine: "postgres" | "mysql",
) {
  const rows = await paginated(
    accessToken,
    `/v1/organizations/${segment(organization)}/databases/${segment(database)}/branches`,
  );
  return rows.map((row) => resourceItem(row, {
    includeBranch: true,
    branchEngine: engine,
  }));
}

async function planetScaleBranch(
  accessToken: string,
  organization: string,
  database: string,
  branch: string,
  engine: "postgres" | "mysql",
) {
  const body = object(await apiRequest(
    accessToken,
    `/v1/organizations/${segment(organization)}/databases/${segment(database)}/branches/${segment(branch)}`,
  ));
  const row = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? object(body.data)
    : body;
  return {
    item: resourceItem(row, { includeBranch: true, branchEngine: engine }),
    providerAuditId: requiredString(row.id, "branch id"),
  };
}

async function planetScaleDatabase(
  accessToken: string,
  organization: string,
  database: string,
) {
  const body = object(await apiRequest(
    accessToken,
    `/v1/organizations/${segment(organization)}/databases/${segment(database)}`,
  ));
  const row = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? object(body.data)
    : body;
  return {
    name: requiredString(row.name, "database name"),
    engine: planetScaleEngine(row.kind),
    state: requiredString(row.state, "database state"),
  };
}

export async function validatePlanetScaleResource(
  accessToken: string,
  resource: PlanetScaleResource,
  policy: { production?: boolean; safeMigrations?: boolean | null } = {},
) {
  const live = await inspectPlanetScaleResourceIdentity(accessToken, resource);
  const expectedProduction = policy.production === true;
  if (
    live.databaseState !== "ready"
    || live.branch.ready !== true
    || live.branch.production !== expectedProduction
    || (
      expectedProduction
      && resource.engine === "mysql"
      && (
        policy.safeMigrations !== true
        || live.branch.safeMigrations !== true
      )
    )
    || (
      resource.engine === "mysql"
      && policy.safeMigrations !== undefined
      && policy.safeMigrations !== null
      && live.branch.safeMigrations !== policy.safeMigrations
    )
  ) {
    throw new PlanetScaleRequestError("PlanetScale branch does not match the approved readiness policy", 409);
  }
  return { providerAuditId: live.providerAuditId };
}

/**
 * Cleanup must remain possible after readiness or Safe Migrations drift. This
 * verifies only the exact provider-owned database/branch identity; callers may
 * not use it as issuance or Ready evidence.
 */
export async function inspectPlanetScaleResourceIdentity(
  accessToken: string,
  resource: PlanetScaleResource,
) {
  const database = await planetScaleDatabase(
    accessToken,
    resource.organization,
    resource.database,
  );
  if (
    database.name !== resource.database
    || database.engine !== resource.engine
  ) {
    throw new PlanetScaleRequestError("PlanetScale database was not found", 404);
  }
  const branch = await planetScaleBranch(
    accessToken,
    resource.organization,
    resource.database,
    resource.branch,
    resource.engine,
  );
  if (branch.item.name !== resource.branch) {
    throw new PlanetScaleRequestError("PlanetScale branch was not found", 404);
  }
  return {
    providerAuditId: branch.providerAuditId,
    databaseState: database.state,
    branch: branch.item,
  };
}

function connectionParts(value: string, protocol: "postgresql" | "mysql") {
  const url = new URL(value.includes("://") ? value : `${protocol}://${value}`);
  if (
    ![`${protocol}:`, ...(protocol === "postgresql" ? ["postgres:"] : [])]
      .includes(url.protocol)
  ) {
    throw new PlanetScaleRequestError("PlanetScale returned an invalid database address", 502);
  }
  const port = url.port ? Number(url.port) : protocol === "postgresql" ? 5432 : 3306;
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (
    !url.hostname
    || port < 1
    || port > 65_535
    || (protocol === "postgresql" && !database)
  ) {
    throw new PlanetScaleRequestError("PlanetScale returned an invalid database address", 502);
  }
  return { host: url.hostname, port, database };
}

export async function issuePlanetScaleLease(
  accessToken: string,
  resource: PlanetScaleResource,
  accessMode: "read" | "write",
  label: string,
): Promise<PlanetScaleLease> {
  const base = `/v1/organizations/${segment(resource.organization)}/databases/${
    segment(resource.database)
  }/branches/${segment(resource.branch)}`;
  if (resource.engine === "postgres") {
    const body = object(await apiRequest(accessToken, `${base}/roles`, {
      method: "POST",
      body: JSON.stringify({
        name: label,
        ttl: PLANETSCALE_LEASE_SECONDS,
        inherited_roles: accessMode === "write"
          ? ["pg_read_all_data", "pg_write_all_data"]
          : ["pg_read_all_data"],
        require_where_on_delete: "on",
        require_where_on_update: "on",
      }),
    }));
    const externalCredentialId = requiredString(body.id, "role id");
    try {
      const address = connectionParts(
        requiredString(body.access_host_url, "access_host_url"),
        "postgresql",
      );
      return {
        externalCredentialId,
        externalCredentialKind: "role",
        ...address,
        database: typeof body.database_name === "string" ? body.database_name : address.database,
        username: requiredString(body.username, "username"),
        password: requiredString(body.password, "password"),
        sslmode: "verify-full",
        expiresAt: parseExpiresAt(body.expires_at, PLANETSCALE_LEASE_SECONDS),
      };
    } catch (error) {
      try {
        await revokePlanetScaleLease(
          accessToken,
          resource,
          "role",
          externalCredentialId,
        );
      } catch {
        throw new PlanetScaleLeaseCleanupRequiredError("role", externalCredentialId);
      }
      throw error;
    }
  }

  const body = object(await apiRequest(accessToken, `${base}/passwords`, {
    method: "POST",
    body: JSON.stringify({
      name: label,
      role: accessMode === "write" ? "readwriter" : "reader",
      ttl: PLANETSCALE_LEASE_SECONDS,
    }),
  }));
  const externalCredentialId = requiredString(body.id, "password id");
  try {
    const address = connectionParts(
      requiredString(body.access_host_url, "access_host_url"),
      "mysql",
    );
    return {
      externalCredentialId,
      externalCredentialKind: "password",
      ...address,
      database: resource.database,
      username: requiredString(body.username, "username"),
      password: requiredString(body.plain_text, "plain_text"),
      sslmode: "verify-full",
      expiresAt: parseExpiresAt(body.expires_at, PLANETSCALE_LEASE_SECONDS),
    };
  } catch (error) {
    try {
      await revokePlanetScaleLease(
        accessToken,
        resource,
        "password",
        externalCredentialId,
      );
    } catch {
      throw new PlanetScaleLeaseCleanupRequiredError("password", externalCredentialId);
    }
    throw error;
  }
}

export async function revokePlanetScaleLease(
  accessToken: string,
  resource: PlanetScaleResource,
  credentialKind: "role" | "password",
  credentialId: string,
) {
  const collection = credentialKind === "role" ? "roles" : "passwords";
  await apiRequest(
    accessToken,
    `/v1/organizations/${segment(resource.organization)}/databases/${
      segment(resource.database)
    }/branches/${segment(resource.branch)}/${collection}/${segment(credentialId)}`,
    { method: "DELETE" },
  );
}

export async function revokePlanetScaleAuthorization(token: string) {
  const { clientId, clientSecret } = credentials();
  const response = await fetch(`${AUTH_ORIGIN}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new PlanetScaleRequestError("PlanetScale authorization could not be revoked", 502);
  });
  if (!response.ok) {
    throw new PlanetScaleRequestError("PlanetScale authorization could not be revoked", 502);
  }
}
