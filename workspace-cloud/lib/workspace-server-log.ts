// The only application-owned server log sink. Every event has a closed,
// categorical projection: no request/response bodies, identifiers, SQL, result
// rows, credentials, certificates, provider messages, or Error objects cross it.
import "server-only";

const PROVIDERS = new Set(["planetScale", "neon", "gcpCloudSql"]);
const CONNECTION_STAGES = new Set([
  "provider_authorization",
  "gcp_setup_ticket",
  "gcp_credential_validation",
  "integration_lookup",
  "credential_sealing",
  "lease_revocation",
  "integration_persistence",
  "setup_consumption",
]);
const GCP_REQUEST_STAGES = new Set([
  "federation",
  "serviceAccount",
  "cloudSqlAdmin.connectSettings",
  "cloudSqlAdmin.instance",
]);
const GCP_CALLBACK_STAGES = new Set([
  "token_exchange",
  "credential_sealing",
  "expired_session_cleanup",
  "setup_session_insert",
]);
const DATABASE_SCHEMA_ERROR_CODES = new Set([
  "3F000",
  "42P01",
  "42703",
  "42704",
  "42883",
]);
const GOOGLE_STATUSES = new Set([
  "ABORTED",
  "ALREADY_EXISTS",
  "DEADLINE_EXCEEDED",
  "FAILED_PRECONDITION",
  "INTERNAL",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "UNAUTHENTICATED",
  "UNAVAILABLE",
]);
const GOOGLE_REASONS = new Set([
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  "API_KEY_INVALID",
  "BILLING_DISABLED",
  "CREDENTIALS_MISSING",
  "IAM_PERMISSION_DENIED",
  "LOCATION_POLICY_VIOLATED",
  "ORG_RESTRICTION_VIOLATION",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_PROJECT_INVALID",
  "SECURITY_POLICY_VIOLATED",
  "SERVICE_DISABLED",
]);

type SafeLogScalar = string | number | boolean | null;

function category(value: unknown, allowed: Set<string>, fallback = "other") {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function optionalCategory(value: unknown, allowed: Set<string>) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function safeStatus(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : 0;
}

function databaseFailureKind(value: unknown) {
  if (typeof value !== "string" || !/^[0-9A-Z]{5}$/.test(value)) return null;
  if (value === "23505") return "unique_conflict";
  if (DATABASE_SCHEMA_ERROR_CODES.has(value)) return "database_schema";
  if (value.startsWith("08")) return "database_unavailable";
  return "other";
}

function emitServerFailure(
  event: string,
  fields: Readonly<Record<string, SafeLogScalar>>,
) {
  console.error(event, fields);
}

export function logProviderConnectionFailure(input: {
  provider: unknown;
  stage: unknown;
  postgresCode: unknown;
}) {
  emitServerFailure("provider_connection_failed", {
    provider: category(input.provider, PROVIDERS),
    stage: category(input.stage, CONNECTION_STAGES),
    databaseKind: databaseFailureKind(input.postgresCode),
  });
}

export function logGcpManagedAccessUpstreamRejection(input: {
  stage: unknown;
  upstreamStatus: unknown;
  googleStatus: unknown;
  googleReason: unknown;
}) {
  emitServerFailure("gcp_managed_access_upstream_rejection", {
    stage: category(input.stage, GCP_REQUEST_STAGES),
    upstreamStatus: safeStatus(input.upstreamStatus),
    googleStatus: optionalCategory(input.googleStatus, GOOGLE_STATUSES),
    googleReason: optionalCategory(input.googleReason, GOOGLE_REASONS),
  });
}

export function logGcpCloudSetupCallbackFailure(input: {
  stage: unknown;
  providerRequest: boolean;
  status: unknown;
}) {
  emitServerFailure("gcp_cloud_setup_callback_failed", {
    stage: category(input.stage, GCP_CALLBACK_STAGES),
    kind: input.providerRequest ? "provider_request" : "unexpected",
    status: input.providerRequest ? safeStatus(input.status) : 0,
  });
}

export function logManagedDatabaseAccessFailure(input: {
  provider: unknown;
  providerRequest: boolean;
  status: unknown;
  databaseCode: unknown;
}) {
  const databaseKind = databaseFailureKind(input.databaseCode);
  const kind = input.providerRequest
    ? "provider_request"
    : databaseKind === "database_schema" || databaseKind === "database_unavailable"
      ? databaseKind
      : "unexpected";
  emitServerFailure("managed_database_access_failed", {
    provider: category(input.provider, PROVIDERS),
    kind,
    status: input.providerRequest ? safeStatus(input.status) : 0,
  });
}
