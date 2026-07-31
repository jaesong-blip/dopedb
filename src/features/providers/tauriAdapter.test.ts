import { beforeEach, describe, expect, it, vi } from "vitest";

import adapterSource from "./tauriAdapter.ts?raw";
import authRouteSource from "../../../workspace-cloud/app/api/auth/[...all]/route.ts?raw";
import gcpBootstrapSource from "../../../workspace-cloud/lib/providers/gcp-cloud-bootstrap.ts?raw";
import gcpOAuthSource from "../../../workspace-cloud/lib/providers/gcp-cloud-oauth.ts?raw";
import providerIntegrationRouteSource from "../../../workspace-cloud/app/api/v1/workspaces/[workspaceId]/provider-integrations/route.ts?raw";
import gcpSetupSource from "../../../workspace-cloud/features/providerAccess/GcpCloudSetup.tsx?raw";
import providerIntegrationListSource from "../../../workspace-cloud/features/providerAccess/ProviderIntegrationList.tsx?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { providerBindingId, providerCredentialReceiptId, providerIntegrationId } from "./domain";
import {
  beginProviderCredentialBinding,
  beginProviderCredentialBindingPayload,
  listProviderCredentialBindings,
  listProviderIntegrations,
  revokeProviderCredentialBinding,
  verifyProviderCredentialBinding,
} from "./tauriAdapter";

const integrationId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const receiptId = "33333333-3333-4333-8333-333333333333";
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
      .mockResolvedValueOnce({ receiptId, expiresAt: "2026-07-27T00:05:00.000Z" })
      .mockResolvedValueOnce(binding)
      .mockResolvedValueOnce(undefined);

    await expect(listProviderIntegrations()).resolves.toEqual([
      expect.objectContaining({ id: providerIntegrationId(integrationId) }),
    ]);
    await expect(listProviderCredentialBindings()).resolves.toEqual([
      expect.objectContaining({ id: providerBindingId(bindingId) }),
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
    expect(invokeMock).toHaveBeenNthCalledWith(3, "begin_provider_credential_binding", {
      integrationId,
      credential: { type: "neonApiKey", apiKey: "one-shot-key" },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "verify_provider_credential_binding", {
      receiptId,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "revoke_provider_credential_binding", { id: bindingId });
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
    expect(providerIntegrationListSource).toContain(
      'provider.availability === "available"',
    );
    expect(providerIntegrationListSource).not.toContain('"준비 중"');
    expect(gcpOAuthSource).toContain('"/api/auth/callback/google"');
    expect(authRouteSource).toContain("isGcpCloudSetupCallback");
    expect(gcpBootstrapSource).toContain("verifyVercelOidcToken");
    expect(gcpBootstrapSource).toContain("roles/iam.workloadIdentityUser");
    expect(gcpBootstrapSource).toContain("configureDatabasePrivileges");
    expect(gcpBootstrapSource).toContain("Temporary Cloud SQL privilege bootstrap cleanup failed");
  });
});
