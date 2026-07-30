// Short-lived Google Cloud administrator authorization used only to discover
// and bootstrap keyless WIF. Refresh tokens are neither requested nor stored.
import "server-only";

import { env } from "../env";
import { ProviderRequestError } from "./provider-types";
import { gcpCloudSqlEngine } from "./gcp-cloud-sql-core";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const RESOURCE_MANAGER = "https://cloudresourcemanager.googleapis.com/v3";
const SQL_ADMIN = "https://sqladmin.googleapis.com/sql/v1beta4";
const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const REQUEST_TIMEOUT_MS = 20_000;

export type GcpSetupCredential = {
  accessToken: string;
  expiresAt: string;
  email: string;
};

export type GcpOAuthProject = {
  id: string;
  number: string;
  name: string;
};

export type GcpOAuthInstance = {
  id: string;
  name: string;
  engine: "postgres" | "mysql";
  region: string;
  ready: boolean;
  production: true | false | "unknown";
  iamAuthenticationEnabled: boolean;
};

function callbackUrl() {
  return new URL("/api/auth/callback/google", env.appOrigin()).toString();
}

export function gcpCloudAuthorizationUrl(state: string) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", env.googleClientId());
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", `openid email ${CLOUD_SCOPE}`);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "select_account consent");
  return url.toString();
}

async function googleJson(url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new ProviderRequestError("gcpCloudSql", "Google Cloud is unavailable", 502);
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body) {
    throw new ProviderRequestError("gcpCloudSql", "Google Cloud rejected the request", 403);
  }
  return body;
}

export async function exchangeGcpCloudCode(code: string): Promise<GcpSetupCredential> {
  const token = await googleJson(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId(),
      client_secret: env.googleClientSecret(),
      redirect_uri: callbackUrl(),
      grant_type: "authorization_code",
    }),
  });
  const accessToken = typeof token.access_token === "string" ? token.access_token : "";
  const expiresIn = typeof token.expires_in === "number" ? token.expires_in : 0;
  if (
    accessToken.length < 32
    || accessToken.length > 8_192
    || expiresIn < 60
    || expiresIn > 3_700
    || typeof token.refresh_token === "string"
  ) {
    throw new ProviderRequestError("gcpCloudSql", "Google returned an unsafe setup token", 502);
  }
  const profile = await googleJson(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const email = typeof profile.email === "string" ? profile.email.toLowerCase() : "";
  if (!/^[^@\s]{1,128}@[^@\s]{1,190}$/.test(email) || profile.email_verified !== true) {
    throw new ProviderRequestError("gcpCloudSql", "A verified Google account is required", 403);
  }
  return {
    accessToken,
    email,
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
  };
}

function bearer(credential: GcpSetupCredential) {
  if (Date.parse(credential.expiresAt) <= Date.now() + 30_000) {
    throw new ProviderRequestError("gcpCloudSql", "Google Cloud setup session expired", 401);
  }
  return { authorization: `Bearer ${credential.accessToken}` };
}

function production(details: Record<string, unknown>): true | false | "unknown" {
  const settings = details.settings as Record<string, unknown> | undefined;
  const labels = settings?.userLabels as Record<string, unknown> | undefined;
  const value = typeof labels?.environment === "string"
    ? labels.environment.trim().toLowerCase()
    : "";
  if (value === "prod" || value === "production") return true;
  if (["dev", "development", "stage", "staging", "test", "sandbox"].includes(value)) {
    return false;
  }
  return "unknown";
}

export async function listGcpOAuthProjects(
  credential: GcpSetupCredential,
): Promise<GcpOAuthProject[]> {
  const body = await googleJson(
    `${RESOURCE_MANAGER}/projects?query=state%3AACTIVE&pageSize=100`,
    { headers: bearer(credential) },
  );
  if (typeof body.nextPageToken === "string") {
    throw new ProviderRequestError("gcpCloudSql", "Google Cloud project scope is too large", 409);
  }
  const rows = Array.isArray(body.projects) ? body.projects : [];
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const id = typeof row.projectId === "string" ? row.projectId : "";
    const number = typeof row.name === "string" ? row.name.replace(/^projects\//, "") : "";
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id) || !/^[1-9][0-9]{5,19}$/.test(number)) {
      return [];
    }
    return [{ id, number, name: typeof row.displayName === "string" ? row.displayName : id }];
  });
}

export async function listGcpOAuthInstances(
  credential: GcpSetupCredential,
  projectId: string,
): Promise<GcpOAuthInstance[]> {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new ProviderRequestError("gcpCloudSql", "Invalid Google Cloud project", 400);
  }
  const body = await googleJson(
    `${SQL_ADMIN}/projects/${encodeURIComponent(projectId)}/instances`,
    { headers: bearer(credential) },
  );
  const rows = Array.isArray(body.items) ? body.items : [];
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const engine = gcpCloudSqlEngine(row.databaseVersion);
    const id = typeof row.name === "string" ? row.name : "";
    if (!engine || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,97}$/.test(id)) return [];
    const settings = row.settings as Record<string, unknown> | undefined;
    const flags = Array.isArray(settings?.databaseFlags) ? settings.databaseFlags : [];
    const requiredFlag = engine === "postgres"
      ? "cloudsql.iam_authentication"
      : "cloudsql_iam_authentication";
    const iamAuthenticationEnabled = flags.some((flag) => {
      if (!flag || typeof flag !== "object" || Array.isArray(flag)) return false;
      const item = flag as Record<string, unknown>;
      return item.name === requiredFlag
        && ["on", "true", "1"].includes(String(item.value).toLowerCase());
    });
    return [{
      id,
      name: id,
      engine,
      region: typeof row.region === "string" ? row.region : "unknown",
      ready: row.state === "RUNNABLE",
      production: production(row),
      iamAuthenticationEnabled,
    }];
  });
}
