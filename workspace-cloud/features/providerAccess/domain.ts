export type ResourceLevel = { key: string; kind: string; label: string };
export type Provider = {
  id: string;
  name: string;
  configured: boolean;
  note: string;
  leaseSeconds: number | null;
  setupKind: "oauth" | "apiKey";
  supportedEngines: string[];
  resourceLevels: [ResourceLevel, ResourceLevel, ResourceLevel];
};

export type Integration = {
  id: string;
  provider: string;
  status: "active" | "reconnect_required";
  generation: string;
  reconnectRequired?: boolean;
  displayName: string;
  grantedScope: string | null;
  updatedAt: string;
  credentialMode: "managed";
};

export type SharedConnection = {
  id: string;
  name: string;
  engine: string;
  credentialMode: "managed" | "member_local";
  allowWrites: boolean;
};

export type Resource = {
  id: string;
  name: string;
  value: string;
  kind?: "postgres" | "mysql";
  // Server classification is tri-state; unknown must never look non-production.
  production?: boolean | "unknown";
  ready?: boolean;
  safeMigrations?: boolean;
  selectionProof?: string;
  receipt?: string;
  receiptExpiresAt?: string;
};

export function selectableProviderResources(
  items: Resource[],
  isFinalLeaf: boolean,
  supportedEngines: string[],
  allowUnknownClassification = false,
) {
  return items.filter((item) => (
    (!item.kind || supportedEngines.includes(item.kind))
    && (!isFinalLeaf || (
      item.ready === true
      && (
        item.production === false
        || item.production === true
        || (allowUnknownClassification && item.production === "unknown")
      )
    ))
  ));
}

export function providerImportDisplayName(providerName: string, resourceName: string) {
  return `${providerName} · ${resourceName}`
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
}

/** UI-only eligibility; the route rechecks canonical import authority atomically. */
export function canUseLocalProviderCredential(
  connection: Pick<SharedConnection, "credentialMode"> | null,
  managed: Pick<ManagedConnection, "integrationId" | "resource"> | null,
) {
  return Boolean(
    connection?.credentialMode === "managed"
      && managed?.integrationId
      && Object.keys(managed.resource).length > 0,
  );
}

export type PendingProviderImport = {
  integrationId: string;
  connectionId: string | null;
  receipt: string;
  name: string;
  body: string;
};

export type ManagedConnection = {
  connectionId: string;
  integrationId: string;
  provider: string;
  resource: Record<string, string>;
};

export type NeonConfiguration = {
  apiKey: string;
  organizationId: string;
};

export type NeonEnvironmentClassification = "" | "development" | "production";

export type NeonBootstrapFinding = {
  code: string;
  level: "blocker" | "change" | "verified";
  description: string;
  target: string;
  before: string;
  after: string;
  requiresApproval: "publicAcl" | null;
  rollbackAvailable: boolean;
};

export type NeonBootstrapReport = {
  version: 1;
  status: "blocked" | "approvalRequired" | "readyToApply";
  planHash: string;
  providerAuditId: string;
  production: boolean;
  target: {
    project: string;
    branch: string;
    databaseId: string;
    database: string;
    schemas: string[];
  };
  findings: NeonBootstrapFinding[];
  requiresPublicAclApproval: boolean;
  requiresProductionApproval: boolean;
  canRollback: boolean;
};

export type NeonBootstrapState = {
  report: NeonBootstrapReport | null;
  plan: string;
  planExpiresAt: string;
  receipt: string;
  receiptExpiresAt: string;
};

export const emptyNeonBootstrap: NeonBootstrapState = {
  report: null,
  plan: "",
  planExpiresAt: "",
  receipt: "",
  receiptExpiresAt: "",
};

function strictRecord(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === keys.length
    && keys.every((key) => Object.hasOwn(row, key))
    ? row
    : null;
}

function boundedText(value: unknown, maximum = 1_024) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseNeonBootstrapFinding(value: unknown): NeonBootstrapFinding | null {
  const row = strictRecord(value, [
    "code",
    "level",
    "description",
    "target",
    "before",
    "after",
    "requiresApproval",
    "rollbackAvailable",
  ]);
  if (
    !row
    || typeof row.code !== "string"
    || !/^NEON_[A-Z0-9_]{1,96}$/.test(row.code)
    || (row.level !== "blocker" && row.level !== "change" && row.level !== "verified")
    || !boundedText(row.description, 2_048)
    || !boundedText(row.target)
    || !boundedText(row.before)
    || !boundedText(row.after)
    || (row.requiresApproval !== null && row.requiresApproval !== "publicAcl")
    || typeof row.rollbackAvailable !== "boolean"
  ) {
    return null;
  }
  return row as NeonBootstrapFinding;
}

function parseNeonBootstrapReport(value: unknown): NeonBootstrapReport | null {
  const row = strictRecord(value, [
    "version",
    "status",
    "planHash",
    "providerAuditId",
    "production",
    "target",
    "findings",
    "requiresPublicAclApproval",
    "requiresProductionApproval",
    "canRollback",
  ]);
  const target = strictRecord(row?.target, [
    "project",
    "branch",
    "databaseId",
    "database",
    "schemas",
  ]);
  if (
    !row
    || row.version !== 1
    || (
      row.status !== "blocked"
      && row.status !== "approvalRequired"
      && row.status !== "readyToApply"
    )
    || typeof row.planHash !== "string"
    || !/^[0-9a-f]{64}$/.test(row.planHash)
    || !boundedText(row.providerAuditId, 2_048)
    || typeof row.production !== "boolean"
    || !target
    || !boundedText(target.project)
    || !boundedText(target.branch)
    || !boundedText(target.databaseId)
    || !boundedText(target.database)
    || !Array.isArray(target.schemas)
    || target.schemas.length === 0
    || target.schemas.length > 32
    || !target.schemas.every((schema) => boundedText(schema, 128))
    || !Array.isArray(row.findings)
    || row.findings.length === 0
    || row.findings.length > 64
    || typeof row.requiresPublicAclApproval !== "boolean"
    || typeof row.requiresProductionApproval !== "boolean"
    || typeof row.canRollback !== "boolean"
  ) {
    return null;
  }
  const findings = row.findings.map(parseNeonBootstrapFinding);
  if (findings.some((item) => item === null)) return null;
  const parsedFindings = findings as NeonBootstrapFinding[];
  const hasBlocker = parsedFindings.some((item) => item.level === "blocker");
  const requiresPublicAclApproval = parsedFindings.some(
    (item) => item.requiresApproval === "publicAcl",
  );
  if (
    (row.status === "blocked") !== hasBlocker
    || row.requiresPublicAclApproval !== requiresPublicAclApproval
    || row.requiresProductionApproval !== row.production
    || (
      !hasBlocker
      && row.status !== (
        requiresPublicAclApproval ? "approvalRequired" : "readyToApply"
      )
    )
  ) {
    return null;
  }
  return {
    ...(row as Omit<NeonBootstrapReport, "target" | "findings">),
    target: target as NeonBootstrapReport["target"],
    findings: parsedFindings,
  };
}

function futureIsoDate(value: unknown) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && Date.parse(value) > Date.now();
}

export function parseNeonBootstrapPreflight(value: unknown) {
  const row = strictRecord(value, ["report", "plan", "planExpiresAt"]);
  const report = parseNeonBootstrapReport(row?.report);
  if (
    !row
    || !report
    || typeof row.plan !== "string"
    || row.plan.length < 80
    || row.plan.length > 64 * 1_024
    || !futureIsoDate(row.planExpiresAt)
  ) {
    return null;
  }
  return {
    report,
    plan: row.plan,
    planExpiresAt: row.planExpiresAt as string,
  };
}

export function parseNeonBootstrapApply(value: unknown) {
  const row = strictRecord(value, ["report", "receipt", "receiptExpiresAt"]);
  const report = parseNeonBootstrapReport(row?.report);
  if (
    !row
    || !report
    || typeof row.receipt !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      row.receipt,
    )
    || !futureIsoDate(row.receiptExpiresAt)
  ) {
    return null;
  }
  return {
    report,
    receipt: row.receipt,
    receiptExpiresAt: row.receiptExpiresAt as string,
  };
}

export type GcpSetupProject = {
  id: string;
  number: string;
  name: string;
};

export type GcpSetupInstance = {
  id: string;
  name: string;
  engine: "postgres" | "mysql";
  region: string;
  ready: boolean;
  production: boolean | "unknown";
  iamAuthenticationEnabled: boolean;
};

export type GcpEnvironmentClassification = "" | "production" | "development";

export type GcpSetupInventory = {
  account: string;
  expiresAt: string;
  projects: GcpSetupProject[];
};

export type GcpSetupPermissionRequirement = {
  role: string;
  label: string;
  purpose: string;
  missingPermissions: string[];
};

export type GcpSetupPermissionCheck = {
  account: string;
  projectId: string;
  canAutoGrant: boolean;
  missing: GcpSetupPermissionRequirement[];
};

export function parseGcpSetupPermissionCheck(
  value: unknown,
): GcpSetupPermissionCheck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.account !== "string"
    || typeof row.projectId !== "string"
    || typeof row.canAutoGrant !== "boolean"
    || !Array.isArray(row.missing)
    || row.missing.length > 5
  ) {
    return null;
  }
  const missing = row.missing.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const requirement = item as Record<string, unknown>;
    if (
      typeof requirement.role !== "string"
      || typeof requirement.label !== "string"
      || typeof requirement.purpose !== "string"
      || !Array.isArray(requirement.missingPermissions)
      || requirement.missingPermissions.length > 8
      || !requirement.missingPermissions.every(
        (permission) => typeof permission === "string",
      )
    ) {
      return [];
    }
    return [{
      role: requirement.role,
      label: requirement.label,
      purpose: requirement.purpose,
      missingPermissions: requirement.missingPermissions as string[],
    }];
  });
  if (missing.length !== row.missing.length) return null;
  return {
    account: row.account,
    projectId: row.projectId,
    canAutoGrant: row.canAutoGrant,
    missing,
  };
}

export const emptyNeon: NeonConfiguration = { apiKey: "", organizationId: "" };
