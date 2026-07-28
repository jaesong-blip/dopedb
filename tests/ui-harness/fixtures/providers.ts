// Provider credential fixture는 summary와 one-use receipt만 담는다. API key,
// provider resource name, connection material은 어떤 형태로도 저장하지 않는다.
import type {
  ProviderCredentialBindingSummary,
  ProviderIntegrationSummary,
} from "../../../src/features/providers/domain";
import {
  integrationGeneration,
  providerBindingId,
  providerIntegrationId,
} from "../../../src/features/providers/domain";

export const neonIntegration = {
  id: providerIntegrationId("f1f1f1f1-1111-4111-8111-111111111111"),
  provider: "neon",
  displayName: "Neon fixture workspace",
  integrationGeneration: integrationGeneration("7"),
  credentialMethod: "apiKey",
  state: "credentialsRequired",
} satisfies ProviderIntegrationSummary;

export const gcpIntegration = {
  id: providerIntegrationId("f2f2f2f2-2222-4222-8222-222222222222"),
  provider: "gcpCloudSql",
  displayName: "Cloud SQL fixture project",
  integrationGeneration: integrationGeneration("7"),
  credentialMethod: "adcWif",
  state: "credentialsRequired",
} satisfies ProviderIntegrationSummary;

export const unsupportedIntegration = {
  id: providerIntegrationId("f3f3f3f3-3333-4333-8333-333333333333"),
  provider: "planetScale",
  displayName: "PlanetScale fixture organization",
  integrationGeneration: integrationGeneration("7"),
  credentialMethod: "unsupported",
  state: "unsupported",
} satisfies ProviderIntegrationSummary;

export const providerIntegrations = [
  neonIntegration,
  gcpIntegration,
  unsupportedIntegration,
] satisfies ProviderIntegrationSummary[];

export const readyGcpBinding = {
  id: providerBindingId("f4f4f4f4-4444-4444-8444-444444444444"),
  integrationId: gcpIntegration.id,
  provider: "gcpCloudSql",
  integrationGeneration: integrationGeneration("7"),
  state: "ready",
  updatedAt: "2026-07-28T09:00:00.000Z",
} satisfies ProviderCredentialBindingSummary;
