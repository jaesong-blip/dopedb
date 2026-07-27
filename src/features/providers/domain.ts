// Local provider-credential contracts. These values intentionally exclude API keys,
// OAuth tokens, provider API bodies, and database connection material.

declare const providerIntegrationIdBrand: unique symbol;
declare const providerBindingIdBrand: unique symbol;
declare const providerCredentialReceiptIdBrand: unique symbol;
declare const integrationGenerationBrand: unique symbol;

export type ProviderIntegrationId = string & {
  readonly [providerIntegrationIdBrand]: "ProviderIntegrationId";
};

export type ProviderBindingId = string & {
  readonly [providerBindingIdBrand]: "ProviderBindingId";
};

export type ProviderCredentialReceiptId = string & {
  readonly [providerCredentialReceiptIdBrand]: "ProviderCredentialReceiptId";
};

/** Decimal text avoids unsafe JavaScript coercion of the Rust authority epoch. */
export type IntegrationGeneration = string & {
  readonly [integrationGenerationBrand]: "IntegrationGeneration";
};

export type ProviderKind = "neon" | "gcpCloudSql" | "planetScale";

export type ProviderIntegrationState =
  | "credentialsRequired"
  | "scopeInsufficient"
  | "accessDenied"
  | "unsupported"
  | "unavailable"
  | "ready";

export type ProviderBindingState =
  | "ready"
  | "revoked"
  | "deletionPending"
  | "unavailable";

/** Dialog-only union; transport parsers retain the narrower source-specific state. */
export type ProviderCredentialDialogStatus = ProviderIntegrationState | ProviderBindingState;

export type ProviderCredentialMethod = "apiKey" | "adcWif" | "unsupported";

export type ProviderIntegrationSummary = Readonly<{
  id: ProviderIntegrationId;
  provider: ProviderKind;
  displayName: string;
  integrationGeneration: IntegrationGeneration;
  credentialMethod: ProviderCredentialMethod;
  state: ProviderIntegrationState;
}>;

export type ProviderCredentialBindingSummary = Readonly<{
  id: ProviderBindingId;
  integrationId: ProviderIntegrationId;
  provider: ProviderKind;
  integrationGeneration: IntegrationGeneration;
  state: ProviderBindingState;
  updatedAt: string;
}>;

export type ProviderCredentialReceipt = Readonly<{
  receiptId: ProviderCredentialReceiptId;
  expiresAt: string;
}>;

export type ProviderCredential =
  | Readonly<{ type: "neonApiKey"; apiKey: string }>
  | Readonly<{ type: "gcpAdc" }>;

export type BeginProviderCredentialBindingRequest = Readonly<{
  integrationId: ProviderIntegrationId;
  credential: ProviderCredential;
}>;

export type VerifyProviderCredentialBindingRequest = Readonly<{
  receiptId: ProviderCredentialReceiptId;
}>;

function brandedUuid(
  value: unknown,
  label: string,
): ProviderIntegrationId | ProviderBindingId | ProviderCredentialReceiptId {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value as ProviderIntegrationId | ProviderBindingId | ProviderCredentialReceiptId;
}

export function providerIntegrationId(value: unknown): ProviderIntegrationId {
  return brandedUuid(value, "provider integration id") as ProviderIntegrationId;
}

export function providerBindingId(value: unknown): ProviderBindingId {
  return brandedUuid(value, "provider binding id") as ProviderBindingId;
}

export function providerCredentialReceiptId(value: unknown): ProviderCredentialReceiptId {
  return brandedUuid(value, "provider credential receipt id") as ProviderCredentialReceiptId;
}

export function integrationGeneration(value: unknown): IntegrationGeneration {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Invalid provider integration generation");
  }
  return value as IntegrationGeneration;
}

export function providerIntegrationState(value: unknown): ProviderIntegrationState {
  if (
    value === "credentialsRequired" ||
    value === "scopeInsufficient" ||
    value === "accessDenied" ||
    value === "unsupported" ||
    value === "unavailable" ||
    value === "ready"
  ) {
    return value;
  }
  throw new Error("Invalid provider credential state");
}

export function providerBindingState(value: unknown): ProviderBindingState {
  if (
    value === "ready" ||
    value === "revoked" ||
    value === "deletionPending" ||
    value === "unavailable"
  ) {
    return value;
  }
  throw new Error("Invalid provider binding state");
}

export function providerKind(value: unknown): ProviderKind {
  if (value === "neon" || value === "gcpCloudSql" || value === "planetScale") {
    return value;
  }
  throw new Error("Invalid provider kind");
}

export function providerCredentialMethod(value: unknown): ProviderCredentialMethod {
  if (value === "apiKey" || value === "adcWif" || value === "unsupported") {
    return value;
  }
  throw new Error("Invalid provider credential method");
}

function safeDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Invalid provider display name");
  }
  return value;
}

function safeTimestamp(value: unknown, label = "provider binding timestamp"): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function exactFields(row: Record<string, unknown>, fields: readonly string[], label: string) {
  const keys = Object.keys(row).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label}`);
  }
}

export function parseProviderIntegrationSummary(value: unknown): ProviderIntegrationSummary {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object") throw new Error("Invalid provider integration summary");
  exactFields(
    row,
    ["credentialMethod", "displayName", "id", "integrationGeneration", "provider", "state"],
    "provider integration summary",
  );
  return {
    id: providerIntegrationId(row.id),
    provider: providerKind(row.provider),
    displayName: safeDisplayName(row.displayName),
    integrationGeneration: integrationGeneration(row.integrationGeneration),
    credentialMethod: providerCredentialMethod(row.credentialMethod),
    state: providerIntegrationState(row.state),
  };
}

export function parseProviderCredentialBindingSummary(
  value: unknown,
): ProviderCredentialBindingSummary {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object") throw new Error("Invalid provider credential binding summary");
  exactFields(
    row,
    ["id", "integrationId", "integrationGeneration", "provider", "state", "updatedAt"],
    "provider credential binding summary",
  );
  return {
    id: providerBindingId(row.id),
    integrationId: providerIntegrationId(row.integrationId),
    provider: providerKind(row.provider),
    integrationGeneration: integrationGeneration(row.integrationGeneration),
    state: providerBindingState(row.state),
    updatedAt: safeTimestamp(row.updatedAt),
  };
}

export function parseProviderCredentialReceipt(value: unknown): ProviderCredentialReceipt {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object") throw new Error("Invalid provider credential receipt");
  exactFields(row, ["expiresAt", "receiptId"], "provider credential receipt");
  return {
    receiptId: providerCredentialReceiptId(row.receiptId),
    expiresAt: safeTimestamp(row.expiresAt, "provider credential receipt expiry"),
  };
}
