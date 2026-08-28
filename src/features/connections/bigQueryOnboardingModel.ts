// Pure BigQuery onboarding values shared by validation, queries, and the
// Connection editor without coupling those layers to the controller hook.
import type { BigQueryAuthMode, ConnectionProfile } from "./domain";

export const BIGQUERY_AUTH_MODE_PARAMETER = "authMode";

export function bigQueryAuthMode(
  profile: Pick<ConnectionProfile, "extraParams">,
): BigQueryAuthMode {
  return profile.extraParams[BIGQUERY_AUTH_MODE_PARAMETER] === "serviceAccount"
    ? "serviceAccount"
    : "googleAccount";
}

export function isValidBigQueryProjectId(value: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(value);
}

export function isValidBigQueryDatasetId(value: string): boolean {
  return value.length <= 1024 && /^[A-Za-z0-9_]+$/u.test(value);
}
