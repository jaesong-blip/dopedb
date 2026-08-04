import { beforeEach, describe, expect, it, vi } from "vitest";

import adapterSource from "./tauriAdapter.ts?raw";
import authRouteSource from "../../../workspace-cloud/app/api/auth/[...all]/route.ts?raw";
import gcpBootstrapSource from "../../../workspace-cloud/lib/providers/gcp-cloud-bootstrap.ts?raw";
import gcpCloudSqlSource from "../../../workspace-cloud/lib/providers/gcp-cloud-sql.ts?raw";
import neonSource from "../../../workspace-cloud/lib/providers/neon.ts?raw";
import neonCoreSource from "../../../workspace-cloud/lib/providers/neon-core.ts?raw";
import neonBootstrapSource from "../../../workspace-cloud/lib/providers/neon-bootstrap.ts?raw";
import neonBootstrapRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/provider-integrations/[integrationId]/neon-bootstrap/route.ts?raw";
import gcpSetupRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/provider-integrations/gcp-setup/[setupId]/route.ts?raw";
import gcpOAuthSource from "../../../workspace-cloud/lib/providers/gcp-cloud-oauth.ts?raw";
import managedLeaseRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/connections/[connectionId]/lease/route.ts?raw";
import managedAccessRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/connections/[connectionId]/managed-access/route.ts?raw";
import connectionGrantsRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/connections/[connectionId]/grants/route.ts?raw";
import providerIntegrationRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/provider-integrations/route.ts?raw";
import providerIntegrationDomainSource from "../../../workspace-cloud/lib/provider-integrations/domain.ts?raw";
import providerLeaseCleanupSource from "../../../workspace-cloud/lib/provider-integrations/lease-cleanup.ts?raw";
import providerLeaseIssuanceSource from "../../../workspace-cloud/lib/provider-integrations/lease-issuance.ts?raw";
import gcpSetupSource from "../../../workspace-cloud/features/providerAccess/GcpCloudSetup.tsx?raw";
import providerIntegrationListSource from "../../../workspace-cloud/features/providerAccess/ProviderIntegrationList.tsx?raw";
import providerResourcePickerSource from "../../../workspace-cloud/features/providerAccess/ProviderResourcePicker.tsx?raw";
import providerAccessControllerSource from "../../../workspace-cloud/features/providerAccess/useProviderAccess.ts?raw";
import providerAccessDomainSource from "../../../workspace-cloud/features/providerAccess/domain.ts?raw";
import legacyProviderBackupSource from "../../../workspace-cloud/fixtures/provider-legacy-connection-backup-v1.json?raw";
import providerCatalogSource from "../../../workspace-cloud/lib/provider-catalog.ts?raw";
import providerAdapterContractSource from "../../../workspace-cloud/lib/providers/adapter-contract.ts?raw";
import {
  issueAfterFreshProviderAuthority,
  MANAGED_PROVIDER_AUTHORITY_TIMEOUT_MS,
  verifiedProviderAuditId,
} from "../../../workspace-cloud/lib/providers/provider-types";
import providerImportProjectionSource from "../../../workspace-cloud/lib/providers/import-projection.ts?raw";
import providerImportStoreSource from "../../../workspace-cloud/lib/provider-import-store.ts?raw";
import providerLocalTargetSource from "../../../workspace-cloud/lib/provider-local-target.ts?raw";
import providerProvisioningTargetSource from "../../../workspace-cloud/lib/provider-provisioning-target.ts?raw";
import providerResourcesRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/provider-integrations/[integrationId]/resources/route.ts?raw";
import managedAccessTargetRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/connections/[connectionId]/managed-access-target/route.ts?raw";
import workspaceBackupCoreSource from "../../../workspace-cloud/lib/workspace-backup-core.ts?raw";
import workspaceConnectionsSource from "../../../workspace-cloud/lib/workspace-connections.ts?raw";
import workspacePermissionsSource from "../../../workspace-cloud/lib/workspace-permissions.ts?raw";
import workspaceRevocationGatesSource from "../../../workspace-cloud/lib/revocation-gates.ts?raw";
import workspaceSchemaSource from "../../../workspace-cloud/lib/schema.ts?raw";
import workspaceVersioningStoreSource from "../../../workspace-cloud/lib/workspace-versioning-store.ts?raw";
import desktopSharedConnectionSource from "../../../src-tauri/src/features/workspaces/adapters/control_plane/connections.rs?raw";
import desktopControlPlaneSource from "../../../src-tauri/src/features/workspaces/adapters/control_plane.rs?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import {
  parseProviderProvisioningPlan,
  parseProviderProvisioningDriverStatus,
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
    expect(parseProviderProvisioningDriverStatus({
      provider: "neon",
      prerequisiteKind: "workspaceIntegration",
      prerequisiteName: "Workspace integration",
      minimumVersion: null,
      installedVersion: null,
      activeIdentity: null,
      readiness: "ready",
    })).toEqual(expect.objectContaining({
      provider: "neon",
      prerequisiteKind: "workspaceIntegration",
      readiness: "ready",
    }));
    expect(() => parseProviderProvisioningDriverStatus({
      provider: "neon",
      cliName: "Neon CLI",
      minimumVersion: "1.0.0",
      installedVersion: "1.0.0",
      activeAccount: "owner",
      readiness: "ready",
    })).toThrow("Invalid provider provisioning status");
    expect(() => parseProviderProvisioningDriverStatus({
      provider: "neon",
      prerequisiteKind: "workspaceIntegration",
      prerequisiteName: "Workspace integration",
      minimumVersion: null,
      installedVersion: null,
      activeIdentity: null,
      readiness: "loggedOut",
    })).toThrow("Invalid provider prerequisite status");

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

  it("prohibits legacy provider identity and manual GCP trust input", async () => {
    const order: string[] = [];
    await expect(issueAfterFreshProviderAuthority(
      "neon",
      async () => {
        order.push("revalidate");
        return "fresh-proof";
      },
      async (proof) => {
        order.push(`issue:${proof}`);
        return "lease";
      },
    )).resolves.toBe("lease");
    expect(order).toEqual(["revalidate", "issue:fresh-proof"]);
    expect(verifiedProviderAuditId("neon", "branch-id:database-id"))
      .toBe("branch-id:database-id");
    for (const value of ["", "unsafe\nline", "unsafe\u202edirection", "x".repeat(513)]) {
      expect(() => verifiedProviderAuditId("neon", value)).toThrow(
        "Provider returned an invalid audit identifier",
      );
    }

    vi.useFakeTimers();
    let timedOutIssueCalled = false;
    try {
      const pending = issueAfterFreshProviderAuthority(
        "neon",
        () => new Promise<never>(() => undefined),
        async () => {
          timedOutIssueCalled = true;
          return "unsafe-lease";
        },
      );
      const rejection = expect(pending).rejects.toMatchObject({
        provider: "neon",
        status: 504,
      });
      await vi.advanceTimersByTimeAsync(MANAGED_PROVIDER_AUTHORITY_TIMEOUT_MS);
      await rejection;
      expect(timedOutIssueCalled).toBe(false);
    } finally {
      vi.useRealTimers();
    }

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
    expect(providerIntegrationListSource).toContain("원클릭 연결이 아니며");
    expect(providerIntegrationListSource).toContain(":personal:broad:");
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
    expect(managedLeaseRouteSource).toContain("export const maxDuration = 60");
    expect(providerLeaseIssuanceSource.match(
      /issueAfterFreshProviderAuthority\(/g,
    )).toHaveLength(3);
    expect(providerLeaseIssuanceSource).toContain(
      "providerAuditId: verifiedProviderAuditId",
    );
    expect(managedLeaseRouteSource).toContain(
      "providerAuditId: lease.providerAuditId",
    );
    expect(workspaceRevocationGatesSource).toContain(
      'lease."provider_audit_id" = ${providerAuditId}',
    );
    expect(workspaceSchemaSource).toContain(
      'providerAuditId: text("provider_audit_id")',
    );
    expect(providerLeaseCleanupSource).toContain(
      "'credential.lease.cleanup_deferred'",
    );
    expect(providerLeaseCleanupSource).toContain(
      "'providerAuditId', deferred.\"provider_audit_id\"",
    );
    expect(managedAccessTargetRouteSource).toContain(
      'action: "provider.provisioning.destroy_deferred"',
    );
    expect(workspaceRevocationGatesSource).toContain("workspaceProviderResource.capabilityManifest");
    expect(desktopSharedConnectionSource).not.toContain("SHARED_CONNECTION_WRITE_BLOCKED");
    expect(managedAccessTargetRouteSource).toContain(
      'authorizeWorkspaceConnection(\n    request,\n    workspaceId,\n    connectionId,\n    "manage",',
    );
    expect(managedAccessTargetRouteSource).toContain("loadProviderProvisioningTarget");
    expect(managedAccessTargetRouteSource).toContain("validateGcpCloudSqlResource");
    expect(managedAccessTargetRouteSource).toContain('ownershipMarker("gcpCloudSql", connectionId)');
    expect(managedAccessTargetRouteSource).toContain("validateNeonResource");
    expect(managedAccessTargetRouteSource).toContain('ownershipMarker("neon", connectionId)');
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
    expect(providerResourcesRouteSource).toContain('integration.provider === "planetScale"');
    expect(providerResourcesRouteSource).not.toContain(
      'integration.provider === "planetScale" || integration.provider === "neon"',
    );
    expect(neonCoreSource).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE");
    expect(neonCoreSource).toContain("NEON_CREDENTIAL_SCHEMA_VERSION = 1");
    expect(neonCoreSource).toContain("parseNeonCredential");
    expect(neonCoreSource).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES");
    expect(neonCoreSource).toContain("REVOKE ALL PRIVILEGES ON TABLES");
    expect(neonCoreSource).toContain("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA");
    expect(neonSource).toContain("FROM pg_default_acl d");
    expect(neonSource).toContain("Neon future-object privilege verification failed");
    expect(neonSource).toContain('apiRequest(credential, "/auth")');
    expect(neonSource).toContain("seenCursors.has(next)");
    expect(neonSource).toContain('production: row.protected === true');
    expect(neonSource).not.toContain(
      "row.default === true || row.protected === true",
    );
    expect(providerIntegrationRouteSource).toContain('"api-key-v1"');
    expect(neonSource).toContain(
      "return { providerAuditId: `${branch.value}:${database.id}` }",
    );
    expect(neonSource).toContain("item.id === resource.databaseId");
    expect(neonCoreSource).toContain("databaseId: string");
    expect(neonBootstrapSource).toContain("NEON_REVOKE_PUBLIC_DATABASE_");
    expect(neonBootstrapSource).toContain("NEON_REVOKE_OTHER_DATABASE_PUBLIC_CONNECT");
    expect(neonBootstrapSource).toContain("NEON_PUBLIC_SECURITY_DEFINER");
    expect(neonBootstrapSource).toContain("NEON_LEASE_ROLE_DRIFT");
    expect(neonBootstrapSource).toContain("NEON_READ_WRITE_SMOKE_PLANNED");
    expect(neonBootstrapSource).toContain("expectedPlanHash");
    expect(neonBootstrapSource).toContain("expectedReadyHash");
    expect(neonBootstrapSource).toContain('state: "preflight"');
    expect(neonBootstrapSource).toContain("publicAclApproved");
    expect(neonBootstrapSource).toContain("productionApproved");
    expect(neonBootstrapSource).toContain("negative write smoke failed");
    expect(neonBootstrapSource).toContain("positive write smoke failed");
    expect(neonBootstrapSource).toContain("negative DDL smoke failed");
    expect(neonBootstrapSource).toContain("negative role management smoke failed");
    expect(neonBootstrapSource).toContain("DROP TABLE ${qualifiedTable}");
    expect(neonBootstrapSource).toContain("rolled back");
    expect(neonBootstrapSource).toContain("NeonBootstrapRepairRequiredError");
    expect(neonBootstrapRouteSource).toContain("openProviderDiscoveryProof");
    expect(neonBootstrapRouteSource).toContain("sealNeonBootstrapPlan");
    expect(neonBootstrapRouteSource).toContain("openNeonBootstrapPlan");
    expect(neonBootstrapRouteSource).toContain("recordProviderDiscoveryReceipt");
    expect(neonBootstrapRouteSource).toContain("writeAvailable: true");
    expect(neonBootstrapRouteSource).toContain("temporaryObject");
    expect(neonBootstrapRouteSource).toContain("provider.neon.bootstrap_needs_repair");
    expect(neonBootstrapRouteSource).toContain("recordBootstrapAudit");
    expect(neonBootstrapRouteSource).toContain(
      'authorization.role !== "admin" && authorization.role !== "owner"',
    );
    expect(providerResourcesRouteSource).toContain("canBootstrapNeon");
    expect(providerImportProjectionSource).toContain(
      '(provider !== "neon" && item.production === false)',
    );
    expect(providerAccessDomainSource).toContain("parseNeonBootstrapPreflight");
    expect(providerAccessDomainSource).toContain("parseNeonBootstrapApply");
    expect(providerAccessControllerSource).toContain('action: "preflight"');
    expect(providerAccessControllerSource).toContain('action: "apply"');
    expect(providerAccessControllerSource).toContain("pendingNeonApplyRef");
    expect(providerResourcePickerSource).toContain("Neon 최소권한 준비");
    expect(providerResourcePickerSource).toContain("표시된 PUBLIC 권한 회수를 승인합니다");
    expect(providerResourcePickerSource).not.toMatch(/setup terminal|SQL 입력/);
    expect(neonSource).toContain("NeonLeaseCleanupRequiredError");
    expect(providerLeaseIssuanceSource).toContain(
      "error instanceof NeonLeaseCleanupRequiredError",
    );
    expect(managedAccessTargetRouteSource).toContain("inspectNeonResourceIdentity");
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
