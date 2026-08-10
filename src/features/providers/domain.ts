// Local provider-credential contracts. These values intentionally exclude API keys,
// OAuth tokens, provider API bodies, and database connection material.

declare const providerIntegrationIdBrand: unique symbol;
declare const providerBindingIdBrand: unique symbol;
declare const providerCredentialReceiptIdBrand: unique symbol;
declare const integrationGenerationBrand: unique symbol;
declare const provisioningDiscoveryIdBrand: unique symbol;
declare const provisioningReceiptIdBrand: unique symbol;

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

export type ProvisioningDiscoveryId = string & {
  readonly [provisioningDiscoveryIdBrand]: "ProvisioningDiscoveryId";
};

export type ProvisioningReceiptId = string & {
  readonly [provisioningReceiptIdBrand]: "ProvisioningReceiptId";
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

export type ProvisioningPrerequisiteKind = "officialCli" | "workspaceIntegration";

export type ProvisioningReadiness =
  | "missing"
  | "outdated"
  | "loggedOut"
  | "wrongAccount"
  | "ready";

export type ProvisioningAccessMode = "read" | "write";
export type ProvisioningIntent = "apply" | "destroy";
export type ProvisioningState =
  | "needsSetup"
  | "readyToApply"
  | "applying"
  | "verifying"
  | "ready"
  | "needsRepair"
  | "destroying";
export type ProvisioningPhase =
  | "detect"
  | "discover"
  | "plan"
  | "approve"
  | "apply"
  | "verify"
  | "issue"
  | "reconcile"
  | "destroy";
export type ProvisioningAction =
  | "enableProviderService"
  | "createProviderIdentity"
  | "bindProviderRole"
  | "configureDatabaseAuthentication"
  | "createDatabasePrincipal"
  | "createReadRole"
  | "createWriteRole"
  | "grantExistingObjects"
  | "grantFutureObjects"
  | "verifyProviderTarget"
  | "verifyDatabasePolicy"
  | "smokeTestReadCredential"
  | "smokeTestWriteCredential"
  | "reconcileProviderPolicy"
  | "reconcileDatabasePolicy"
  | "revokeIssuedCredentials"
  | "removeOwnedDatabasePrincipal"
  | "removeOwnedProviderIdentity";
export type ProvisioningRepairReason =
  | "applyFailed"
  | "applyOutcomeUnknown"
  | "verificationFailed"
  | "providerDrift"
  | "databaseDrift"
  | "credentialSmokeFailed"
  | "cleanupFailed"
  | "userCancelled";

export type ProviderProvisioningDriverStatus = Readonly<{
  provider: ProviderKind;
  prerequisiteKind: ProvisioningPrerequisiteKind;
  prerequisiteName: string;
  minimumVersion: string | null;
  installedVersion: string | null;
  activeIdentity: string | null;
  readiness: ProvisioningReadiness;
}>;

export type ProviderProvisioningTarget = Readonly<{
  discoveryId: ProvisioningDiscoveryId;
  provider: ProviderKind;
  displayName: string;
  detail: string;
  engine: "postgres" | "mysql";
  production: boolean;
  expiresAt: string;
}>;

export type ProviderProvisioningPlan = Readonly<{
  receiptId: ProvisioningReceiptId;
  operationId: string;
  connectionId: string;
  provider: ProviderKind;
  targetDisplayName: string;
  targetDetail: string;
  engine: "postgres" | "mysql";
  intent: ProvisioningIntent;
  access: ProvisioningAccessMode;
  production: boolean;
  state: ProvisioningState;
  phase: ProvisioningPhase;
  operationState:
    | "planned"
    | "pending_approval"
    | "ready"
    | "approved"
    | "rejected"
    | "expired"
    | "cancelled"
    | "executing"
    | "succeeded"
    | "failed"
    | "outcome_unknown";
  payloadHash: string;
  confirmationPhrase: string | null;
  completedSteps: number;
  totalSteps: number;
  actions: ProvisioningAction[];
  repairReason: ProvisioningRepairReason | null;
  canExecute: boolean;
  canCancel: boolean;
  canDestroy: boolean;
}>;

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

function safeProvisioningText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function nullableProvisioningText(value: unknown, label: string): string | null {
  return value === null ? null : safeProvisioningText(value, label);
}

function provisioningUuid(value: unknown, label: string): string {
  return brandedUuid(value, label) as string;
}

function provisioningInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 64) {
    throw new Error(`Invalid ${label}`);
  }
  return value as number;
}

function provisioningBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value === "string" && values.includes(value as T)) return value as T;
  throw new Error(`Invalid ${label}`);
}

const provisioningReadinessValues = [
  "missing",
  "outdated",
  "loggedOut",
  "wrongAccount",
  "ready",
] as const;
const provisioningStateValues = [
  "needsSetup",
  "readyToApply",
  "applying",
  "verifying",
  "ready",
  "needsRepair",
  "destroying",
] as const;
const provisioningPhaseValues = [
  "detect",
  "discover",
  "plan",
  "approve",
  "apply",
  "verify",
  "issue",
  "reconcile",
  "destroy",
] as const;
const provisioningActionValues = [
  "enableProviderService",
  "createProviderIdentity",
  "bindProviderRole",
  "configureDatabaseAuthentication",
  "createDatabasePrincipal",
  "createReadRole",
  "createWriteRole",
  "grantExistingObjects",
  "grantFutureObjects",
  "verifyProviderTarget",
  "verifyDatabasePolicy",
  "smokeTestReadCredential",
  "smokeTestWriteCredential",
  "reconcileProviderPolicy",
  "reconcileDatabasePolicy",
  "revokeIssuedCredentials",
  "removeOwnedDatabasePrincipal",
  "removeOwnedProviderIdentity",
] as const;
const provisioningRepairValues = [
  "applyFailed",
  "applyOutcomeUnknown",
  "verificationFailed",
  "providerDrift",
  "databaseDrift",
  "credentialSmokeFailed",
  "cleanupFailed",
  "userCancelled",
] as const;
const operationStateValues = [
  "planned",
  "pending_approval",
  "ready",
  "approved",
  "rejected",
  "expired",
  "cancelled",
  "executing",
  "succeeded",
  "failed",
  "outcome_unknown",
] as const;

export function parseProviderProvisioningDriverStatus(
  value: unknown,
): ProviderProvisioningDriverStatus {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object") throw new Error("Invalid provider provisioning status");
  exactFields(
    row,
    [
      "activeIdentity",
      "installedVersion",
      "minimumVersion",
      "prerequisiteKind",
      "prerequisiteName",
      "provider",
      "readiness",
    ],
    "provider provisioning status",
  );
  const parsed: ProviderProvisioningDriverStatus = {
    provider: providerKind(row.provider),
    prerequisiteKind: oneOf(
      row.prerequisiteKind,
      ["officialCli", "workspaceIntegration"] as const,
      "provider prerequisite kind",
    ),
    prerequisiteName: safeProvisioningText(
      row.prerequisiteName,
      "provider prerequisite name",
    ),
    minimumVersion: nullableProvisioningText(
      row.minimumVersion,
      "provider prerequisite minimum version",
    ),
    installedVersion: nullableProvisioningText(
      row.installedVersion,
      "provider prerequisite version",
    ),
    activeIdentity: nullableProvisioningText(
      row.activeIdentity,
      "provider prerequisite identity",
    ),
    readiness: oneOf(row.readiness, provisioningReadinessValues, "provider readiness"),
  };
  const validOfficialCli = parsed.prerequisiteKind === "officialCli"
    && parsed.minimumVersion !== null
    && (
      (parsed.readiness === "missing"
        && parsed.installedVersion === null
        && parsed.activeIdentity === null)
      || (parsed.readiness === "outdated" && parsed.installedVersion !== null)
      || (parsed.readiness === "loggedOut"
        && parsed.installedVersion !== null
        && parsed.activeIdentity === null)
      || ((parsed.readiness === "wrongAccount" || parsed.readiness === "ready")
        && parsed.installedVersion !== null
        && parsed.activeIdentity !== null)
    );
  const validWorkspaceIntegration = parsed.prerequisiteKind === "workspaceIntegration"
    && parsed.readiness === "ready"
    && parsed.minimumVersion === null
    && parsed.installedVersion === null
    && parsed.activeIdentity === null;
  if (!validOfficialCli && !validWorkspaceIntegration) {
    throw new Error("Invalid provider prerequisite status");
  }
  return parsed;
}

export function parseProviderProvisioningTarget(value: unknown): ProviderProvisioningTarget {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object") throw new Error("Invalid provider provisioning target");
  exactFields(
    row,
    ["detail", "discoveryId", "displayName", "engine", "expiresAt", "production", "provider"],
    "provider provisioning target",
  );
  return {
    discoveryId: provisioningUuid(row.discoveryId, "provider discovery id") as ProvisioningDiscoveryId,
    provider: providerKind(row.provider),
    displayName: safeProvisioningText(row.displayName, "provider target name"),
    detail: safeProvisioningText(row.detail, "provider target detail"),
    engine: oneOf(row.engine, ["postgres", "mysql"] as const, "provider target engine"),
    production: provisioningBoolean(row.production, "provider target environment"),
    expiresAt: safeTimestamp(row.expiresAt, "provider discovery expiry"),
  };
}

export function parseProviderProvisioningPlan(value: unknown): ProviderProvisioningPlan {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object") throw new Error("Invalid provider provisioning plan");
  exactFields(
    row,
    [
      "access", "actions", "canCancel", "canDestroy", "canExecute", "completedSteps",
      "confirmationPhrase", "connectionId", "engine", "intent", "operationId",
      "operationState", "payloadHash", "phase", "production", "provider", "receiptId",
      "repairReason", "state", "targetDetail", "targetDisplayName", "totalSteps",
    ],
    "provider provisioning plan",
  );
  if (!Array.isArray(row.actions) || row.actions.length > 64) {
    throw new Error("Invalid provider provisioning actions");
  }
  const payloadHash = safeProvisioningText(row.payloadHash, "provider provisioning hash");
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) {
    throw new Error("Invalid provider provisioning hash");
  }
  const repairReason = row.repairReason === null
    ? null
    : oneOf(row.repairReason, provisioningRepairValues, "provider repair reason");
  return {
    receiptId: provisioningUuid(row.receiptId, "provider provisioning receipt id") as ProvisioningReceiptId,
    operationId: provisioningUuid(row.operationId, "provider operation id"),
    connectionId: provisioningUuid(row.connectionId, "provider connection id"),
    provider: providerKind(row.provider),
    targetDisplayName: safeProvisioningText(row.targetDisplayName, "provider target name"),
    targetDetail: safeProvisioningText(row.targetDetail, "provider target detail"),
    engine: oneOf(row.engine, ["postgres", "mysql"] as const, "provider target engine"),
    intent: oneOf(row.intent, ["apply", "destroy"] as const, "provider provisioning intent"),
    access: oneOf(row.access, ["read", "write"] as const, "provider provisioning access"),
    production: provisioningBoolean(row.production, "provider target environment"),
    state: oneOf(row.state, provisioningStateValues, "provider provisioning state"),
    phase: oneOf(row.phase, provisioningPhaseValues, "provider provisioning phase"),
    operationState: oneOf(row.operationState, operationStateValues, "provider operation state"),
    payloadHash,
    confirmationPhrase: nullableProvisioningText(
      row.confirmationPhrase,
      "provider confirmation phrase",
    ),
    completedSteps: provisioningInteger(row.completedSteps, "provider completed steps"),
    totalSteps: provisioningInteger(row.totalSteps, "provider total steps"),
    actions: row.actions.map((action) => oneOf(
      action,
      provisioningActionValues,
      "provider provisioning action",
    )),
    repairReason,
    canExecute: provisioningBoolean(row.canExecute, "provider execution state"),
    canCancel: provisioningBoolean(row.canCancel, "provider cancellation state"),
    canDestroy: provisioningBoolean(row.canDestroy, "provider cleanup state"),
  };
}
