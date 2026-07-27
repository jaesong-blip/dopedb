export type ResourceLevel = { key: string; kind: string; label: string };
export type Provider = {
  id: string;
  name: string;
  availability: "available" | "planned";
  configured: boolean;
  note: string;
  leaseSeconds: number | null;
  setupKind: "oauth" | "apiKey" | "cloudTrust" | "connector";
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
  selectionProof?: string;
  receipt?: string;
  receiptExpiresAt?: string;
};

export function selectableProviderResources(
  items: Resource[],
  isFinalLeaf: boolean,
  supportedEngines: string[],
) {
  return items.filter((item) => (
    (!item.kind || supportedEngines.includes(item.kind))
    && (!isFinalLeaf || (item.ready === true && item.production === false))
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

export type GcpConfiguration = {
  projectId: string;
  projectNumber: string;
  workloadIdentityPoolId: string;
  workloadIdentityProviderId: string;
  instanceId: string;
  readServiceAccountEmail: string;
  writeServiceAccountEmail: string;
  dedicatedServiceAccountsConfirmed: boolean;
  instanceScopedIamConfirmed: boolean;
};

export const emptyNeon: NeonConfiguration = { apiKey: "", organizationId: "" };
export const emptyGcp: GcpConfiguration = {
  projectId: "",
  projectNumber: "",
  workloadIdentityPoolId: "",
  workloadIdentityProviderId: "",
  instanceId: "",
  readServiceAccountEmail: "",
  writeServiceAccountEmail: "",
  dedicatedServiceAccountsConfirmed: false,
  instanceScopedIamConfirmed: false,
};
