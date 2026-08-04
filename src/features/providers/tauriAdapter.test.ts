import { beforeEach, describe, expect, it, vi } from "vitest";

import adapterSource from "./tauriAdapter.ts?raw";
import authRouteSource from "../../../workspace-cloud/app/api/auth/[...all]/route.ts?raw";
import gcpBootstrapSource from "../../../workspace-cloud/lib/providers/gcp-cloud-bootstrap.ts?raw";
import gcpCloudSqlSource from "../../../workspace-cloud/lib/providers/gcp-cloud-sql.ts?raw";
import gcpSetupRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/provider-integrations/gcp-setup/[setupId]/route.ts?raw";
import gcpOAuthSource from "../../../workspace-cloud/lib/providers/gcp-cloud-oauth.ts?raw";
import managedLeaseRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/connections/[connectionId]/lease/route.ts?raw";
import managedAccessRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/connections/[connectionId]/managed-access/route.ts?raw";
import connectionGrantsRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/connections/[connectionId]/grants/route.ts?raw";
import providerIntegrationRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/provider-integrations/route.ts?raw";
import providerIntegrationDomainSource from "../../../workspace-cloud/lib/provider-integrations/domain.ts?raw";
import gcpSetupSource from "../../../workspace-cloud/features/providerAccess/GcpCloudSetup.tsx?raw";
import providerIntegrationListSource from "../../../workspace-cloud/features/providerAccess/ProviderIntegrationList.tsx?raw";
import legacyProviderBackupSource from "../../../workspace-cloud/fixtures/provider-legacy-connection-backup-v1.json?raw";
import providerCatalogSource from "../../../workspace-cloud/lib/provider-catalog.ts?raw";
import providerAdapterContractSource from "../../../workspace-cloud/lib/providers/adapter-contract.ts?raw";
import providerImportProjectionSource from "../../../workspace-cloud/lib/providers/import-projection.ts?raw";
import providerImportStoreSource from "../../../workspace-cloud/lib/provider-import-store.ts?raw";
import providerLocalTargetSource from "../../../workspace-cloud/lib/provider-local-target.ts?raw";
import providerProvisioningTargetSource from "../../../workspace-cloud/lib/provider-provisioning-target.ts?raw";
import managedAccessTargetRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/connections/[connectionId]/managed-access-target/route.ts?raw";
import workspaceBackupCoreSource from "../../../workspace-cloud/lib/workspace-backup-core.ts?raw";
import workspaceConnectionsSource from "../../../workspace-cloud/lib/workspace-connections.ts?raw";
import workspacePermissionsSource from "../../../workspace-cloud/lib/workspace-permissions.ts?raw";
import workspaceRevocationGatesSource from "../../../workspace-cloud/lib/revocation-gates.ts?raw";
import workspaceVersioningStoreSource from "../../../workspace-cloud/lib/workspace-versioning-store.ts?raw";
import desktopSharedConnectionSource from "../../../src-tauri/src/features/workspaces/adapters/control_plane/connections.rs?raw";
import desktopControlPlaneSource from "../../../src-tauri/src/features/workspaces/adapters/control_plane.rs?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import {
  parseProviderProvisioningPlan,
  providerBindingId,
  providerCredentialReceiptId,
  providerIntegrationId,
} from "./domain";
import {
  beginProviderCredentialBinding,
  beginProviderCredentialBindingPayload,
  discoverProviderProvisioningTargets,
  listProviderCredentialBindings,
  listProviderIntegrations,
  revokeProviderCredentialBinding,
  verifyProviderCredentialBinding,
} from "./tauriAdapter";

const integrationId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const receiptId = "33333333-3333-4333-8333-333333333333";
const connectionId = "55555555-5555-4555-8555-555555555555";
const discoveryId = "66666666-6666-4666-8666-666666666666";
const integration = {
  id: integrationId,
  provider: "neon",
  displayName: "Read-only Neon",
  integrationGeneration: "12",
  credentialMethod: "apiKey",
  state: "credentialsRequired",
};

const binding = {
  id: bindingId,
  integrationId,
  provider: "neon",
  integrationGeneration: "12",
  state: "ready",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

describe("provider credential Tauri adapter", () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => invokeMock.mockReset());

  it("owns the exact summary-only command wire", async () => {
    invokeMock
      .mockResolvedValueOnce([integration])
      .mockResolvedValueOnce([binding])
      .mockResolvedValueOnce([{
        discoveryId,
        provider: "neon",
        displayName: "Neon app",
        detail: "quiet-sun / main",
        engine: "postgres",
        production: false,
        expiresAt: "2026-08-05T00:05:00.000Z",
      }])
      .mockResolvedValueOnce({ receiptId, expiresAt: "2026-07-27T00:05:00.000Z" })
      .mockResolvedValueOnce(binding)
      .mockResolvedValueOnce(undefined);

    await expect(listProviderIntegrations()).resolves.toEqual([
      expect.objectContaining({ id: providerIntegrationId(integrationId) }),
    ]);
    await expect(listProviderCredentialBindings()).resolves.toEqual([
      expect.objectContaining({ id: providerBindingId(bindingId) }),
    ]);
    await expect(discoverProviderProvisioningTargets("neon", connectionId)).resolves.toEqual([
      expect.objectContaining({ discoveryId }),
    ]);
    await beginProviderCredentialBinding({
      integrationId: providerIntegrationId(integrationId),
      credential: { type: "neonApiKey", apiKey: "one-shot-key" },
    });
    await verifyProviderCredentialBinding({
      receiptId: providerCredentialReceiptId(receiptId),
    });
    await revokeProviderCredentialBinding(providerBindingId(bindingId));

    expect(invokeMock).toHaveBeenNthCalledWith(1, "list_provider_integrations");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "list_provider_credential_bindings");
    expect(invokeMock).toHaveBeenNthCalledWith(3, "discover_provider_provisioning_targets", {
      provider: "neon",
      connectionId,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "begin_provider_credential_binding", {
      integrationId,
      credential: { type: "neonApiKey", apiKey: "one-shot-key" },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "verify_provider_credential_binding", {
      receiptId,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, "revoke_provider_credential_binding", { id: bindingId });
  });

  it("accepts only the exact receipt DTO including a valid expiry timestamp", async () => {
    invokeMock.mockResolvedValueOnce({
      receiptId,
      expiresAt: "2026-07-27T00:05:00.000Z",
      integrationId,
    });
    await expect(beginProviderCredentialBinding({
      integrationId: providerIntegrationId(integrationId),
      credential: { type: "gcpAdc" },
    })).rejects.toThrow("Invalid provider credential receipt");

    invokeMock.mockResolvedValueOnce({ receiptId, expiresAt: "not-a-timestamp" });
    await expect(beginProviderCredentialBinding({
      integrationId: providerIntegrationId(integrationId),
      credential: { type: "gcpAdc" },
    })).rejects.toThrow("Invalid provider credential receipt expiry");

    invokeMock.mockResolvedValueOnce({ receiptId, expiresAt: "2026-07-27T00:05:00.000Z" });
    await beginProviderCredentialBinding({
      integrationId: providerIntegrationId(integrationId),
      credential: { type: "gcpAdc" },
    });
    expect(invokeMock).toHaveBeenLastCalledWith("begin_provider_credential_binding", {
      integrationId,
      credential: { type: "gcpAdc" },
    });
  });

  it("rejects extra or missing integration and binding fields before a query cache can hold them", async () => {
    invokeMock.mockResolvedValueOnce([{ ...integration, token: "must-not-pass" }]);
    await expect(listProviderIntegrations()).rejects.toThrow("Invalid provider integration summary");

    const { displayName: _displayName, ...missingIntegration } = integration;
    invokeMock.mockResolvedValueOnce([missingIntegration]);
    await expect(listProviderIntegrations()).rejects.toThrow("Invalid provider integration summary");

    invokeMock.mockResolvedValueOnce([{ ...binding, principal: "must-not-pass" }]);
    await expect(listProviderCredentialBindings()).rejects.toThrow("Invalid provider credential binding summary");

    const { updatedAt: _updatedAt, ...missingBinding } = binding;
    invokeMock.mockResolvedValueOnce([missingBinding]);
    await expect(listProviderCredentialBindings()).rejects.toThrow("Invalid provider credential binding summary");

    invokeMock.mockResolvedValueOnce([{ ...integration, integrationGeneration: "12.0" }]);
    await expect(listProviderIntegrations()).rejects.toThrow("Invalid provider integration generation");

    invokeMock.mockResolvedValueOnce([{ ...integration, state: "revoked" }]);
    await expect(listProviderIntegrations()).rejects.toThrow("Invalid provider credential state");

    invokeMock.mockResolvedValueOnce([{ ...binding, state: "credentialsRequired" }]);
    await expect(listProviderCredentialBindings()).rejects.toThrow("Invalid provider binding state");

    const provisioningPlan = {
      receiptId,
      operationId: "44444444-4444-4444-8444-444444444444",
      connectionId: "55555555-5555-4555-8555-555555555555",
      provider: "gcpCloudSql",
      targetDisplayName: "mirai-db-dev / app",
      targetDetail: "campfire-460003 · asia-northeast3",
      engine: "postgres",
      intent: "apply",
      access: "read",
      production: false,
      state: "readyToApply",
      phase: "approve",
      operationState: "pendingApproval",
      payloadHash: "ab".repeat(32),
      confirmationPhrase: null,
      completedSteps: 0,
      totalSteps: 2,
      actions: ["createProviderIdentity", "grantExistingObjects"],
      repairReason: null,
      canExecute: false,
      canCancel: false,
      canDestroy: false,
    };
    expect(parseProviderProvisioningPlan(provisioningPlan)).toEqual(provisioningPlan);
    expect(() => parseProviderProvisioningPlan({
      ...provisioningPlan,
      cliArgv: ["projects", "add-iam-policy-binding"],
    })).toThrow("Invalid provider provisioning plan");
    expect(() => parseProviderProvisioningPlan({
      ...provisioningPlan,
      payloadHash: "not-a-hash",
    })).toThrow("Invalid provider provisioning hash");
  });

  it("prohibits legacy provider identity and manual GCP trust input", () => {
    const payload = beginProviderCredentialBindingPayload({
      integrationId: providerIntegrationId(integrationId),
      credential: { type: "gcpAdc" },
    });
    expect(payload).toEqual({ integrationId, credential: { type: "gcpAdc" } });
    expect(Object.keys(payload).sort()).toEqual(["credential", "integrationId"]);
    expect(JSON.stringify(payload)).not.toMatch(/integrationGeneration|bindingId|\"kind\"/);
    const beginSource = adapterSource.slice(
      adapterSource.indexOf("export function beginProviderCredentialBindingPayload"),
      adapterSource.indexOf("export async function listProviderIntegrations"),
    );
    expect(beginSource).not.toMatch(/\b(integrationGeneration|bindingId|kind)\b/);
    expect(providerIntegrationRouteSource).toContain("openProviderBootstrapTicket");
    expect(providerIntegrationRouteSource).not.toContain(
      "parseGcpCloudSqlCredential(body.configuration)",
    );
    expect(gcpSetupSource).toContain("자동 설정하고 연결");
    expect(gcpSetupSource).not.toMatch(
      /workloadIdentityPoolId|workloadIdentityProviderId|readServiceAccountEmail/,
    );
    expect(providerIntegrationListSource).not.toMatch(/availability|"준비 중"/);
    expect(providerCatalogSource).not.toMatch(
      /supportsReadWrite|availability|awsRds|oracleOci|mongodbAtlas/,
    );
    expect(providerCatalogSource.match(/id: "(planetScale|gcpCloudSql|neon)"/g))
      .toHaveLength(3);
    expect(providerIntegrationRouteSource).toContain("id: provider.id");
    expect(providerIntegrationRouteSource).not.toContain("...provider,");
    expect(gcpOAuthSource).toContain('"/api/auth/callback/google"');
    expect(authRouteSource).toContain("isGcpCloudSetupCallback");
    expect(gcpBootstrapSource).toContain("verifyVercelOidcToken");
    expect(gcpBootstrapSource).toContain("roles/iam.workloadIdentityUser");
    expect(gcpBootstrapSource).toContain("configureDatabasePrivileges");
    expect(gcpBootstrapSource).toContain("pg_write_all_data");
    expect(gcpBootstrapSource).toContain("roles/serviceusage.serviceUsageConsumer");
    expect(gcpBootstrapSource).toContain("Temporary Cloud SQL privilege bootstrap cleanup failed");
    expect(gcpCloudSqlSource).toContain("GCP managed access upstream rejection");
    expect(gcpCloudSqlSource).toContain("Cloud SQL Admin denied the managed access check");
    expect(gcpCloudSqlSource).toContain('"x-goog-user-project": credential.projectId');
    expect(gcpCloudSqlSource).toContain("Cloud SQL instance identity changed during verification");
    expect(gcpCloudSqlSource).toContain("return { providerAuditId: connectionName }");
    expect(gcpCloudSqlSource).not.toContain("iamDatabaseUsersWithToken");
    expect(providerIntegrationDomainSource).toContain('networkMode: "PUBLIC"');
    expect(providerIntegrationDomainSource).not.toContain(
      'networkMode: input.selection.networkMode || "PRIVATE_SERVICES_ACCESS"',
    );
    expect(desktopControlPlaneSource).toContain(".or(value.error.as_deref())");
    expect(gcpSetupRouteSource).toContain("writeAccess: true");
    expect(managedLeaseRouteSource).toContain('let requestedAccessMode: "read" | "write"');
    expect(managedLeaseRouteSource).toContain("providerResourceSupportsWrite");
    expect(workspaceRevocationGatesSource).toContain("workspaceProviderResource.capabilityManifest");
    expect(desktopSharedConnectionSource).not.toContain("SHARED_CONNECTION_WRITE_BLOCKED");
    expect(managedAccessTargetRouteSource).toContain(
      'authorizeWorkspaceConnection(\n    request,\n    workspaceId,\n    connectionId,\n    "manage",',
    );
    expect(managedAccessTargetRouteSource).toContain("loadProviderProvisioningTarget");
    expect(managedAccessTargetRouteSource).toContain("validateGcpCloudSqlResource");
    expect(managedAccessTargetRouteSource).toContain('ownershipMarker("gcpCloudSql", connectionId)');
    expect(providerProvisioningTargetSource).toContain(
      "workspaceProviderImportRequest.connectionId, workspaceConnection.id",
    );
    expect(providerProvisioningTargetSource).toContain(
      "workspaceConnection.providerResource} = ${workspaceProviderResource.resource}",
    );
    expect(providerProvisioningTargetSource).toContain(
      "createHash(\"sha256\").update(row.externalAccountId).digest(\"hex\")",
    );
    expect(providerProvisioningTargetSource).toContain("AUTHORITY_TTL_MS = 5 * 60 * 1_000");

    expect(providerAdapterContractSource).toContain("write: boolean");
    expect(providerImportProjectionSource).toContain(
      'if (provider !== "gcpCloudSql" && provider !== "planetScale")',
    );
    expect(providerImportProjectionSource).toContain(
      'item.kind === "mysql" && item.safeMigrations === true',
    );
    expect(providerImportProjectionSource).toContain(
      "capabilities: { ...projected.capabilities, write: true }",
    );
    expect(workspaceConnectionsSource).toContain(
      'credentialMode === "member_local" && allowWrites',
    );
    expect(workspaceConnectionsSource).toContain("allowWrites: effectiveWrite");
    expect(workspacePermissionsSource).toContain(
      'hasWorkspaceCapability(role, "write")',
    );
    expect(workspacePermissionsSource).toContain('return "write" as const');
    expect(workspaceVersioningStoreSource).toContain(
      '"connection.write_policy.update"',
    );
    expect(workspaceVersioningStoreSource).toContain(
      `member."role" IN ('admin', 'owner')`,
    );
    const rawConnectionGrantSql = [
      connectionGrantsRouteSource,
      managedAccessRouteSource,
      providerImportStoreSource,
      providerLocalTargetSource,
      workspaceVersioningStoreSource,
    ];
    for (const source of rawConnectionGrantSql) {
      expect(source).not.toMatch(
        /(?:workspace_connection_grant"|workspaceConnectionGrant\})\s+(?:AS\s+)?grant\b/,
      );
      expect(source).not.toMatch(/FOR UPDATE OF[^\n]*\bgrant\b/);
    }
    const providerImportAuditSql = providerImportStoreSource.slice(
      providerImportStoreSource.indexOf("), audit AS MATERIALIZED ("),
      providerImportStoreSource.indexOf("), recorded AS MATERIALIZED ("),
    );
    expect(providerImportAuditSql).toContain("JOIN fresh ON TRUE");
    expect(providerImportStoreSource.match(
      /'productionApproved', \$\{input\.productionApproved\}::boolean/g,
    )).toHaveLength(2);
    expect(providerImportAuditSql).toContain(
      "'preservedConnectionId', ${replacing}::boolean",
    );

    const legacyBackup = JSON.parse(legacyProviderBackupSource);
    expect(legacyBackup.connections).toEqual([
      expect.objectContaining({
        provider: "gcpCloudSql",
        readonlyDefault: false,
        allowWrites: true,
      }),
    ]);
    expect(workspaceBackupCoreSource).toContain("parseBackupConnection(template)");
    expect(workspaceBackupCoreSource).toContain("...parseBackupConnection(template)");
    expect(workspaceVersioningStoreSource).toContain("readonlyDefault: true");
    expect(workspaceVersioningStoreSource).toContain("allowWrites: false");
    expect(JSON.stringify(legacyBackup)).not.toMatch(
      /password|secret|token|credential|serviceAccount/i,
    );
  });
});
