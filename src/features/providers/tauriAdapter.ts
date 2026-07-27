// The sole frontend owner of local-provider command literals. Requests carry a
// short-lived receipt or a one-shot form value; no provider secret is retained here.
import { invoke } from "@tauri-apps/api/core";

import {
  parseProviderCredentialBindingSummary,
  parseProviderCredentialReceipt,
  parseProviderIntegrationSummary,
  type BeginProviderCredentialBindingRequest,
  type ProviderBindingId,
  type ProviderCredentialBindingSummary,
  type ProviderCredentialReceipt,
  type ProviderIntegrationSummary,
  type VerifyProviderCredentialBindingRequest,
} from "./domain";

function arrayResponse<T>(value: unknown, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid provider credential response");
  return value.map(parse);
}

/** The canonical desktop wire is intentionally narrower than receipt authority. */
export function beginProviderCredentialBindingPayload(
  request: BeginProviderCredentialBindingRequest,
) {
  return {
    integrationId: request.integrationId,
    credential: request.credential,
  };
}

export async function listProviderIntegrations(): Promise<ProviderIntegrationSummary[]> {
  return arrayResponse(
    await invoke("list_provider_integrations"),
    parseProviderIntegrationSummary,
  );
}

export async function listProviderCredentialBindings(): Promise<ProviderCredentialBindingSummary[]> {
  return arrayResponse(
    await invoke("list_provider_credential_bindings"),
    parseProviderCredentialBindingSummary,
  );
}

export async function beginProviderCredentialBinding(
  request: BeginProviderCredentialBindingRequest,
): Promise<ProviderCredentialReceipt> {
  return parseProviderCredentialReceipt(await invoke(
    "begin_provider_credential_binding",
    beginProviderCredentialBindingPayload(request),
  ));
}

export async function verifyProviderCredentialBinding(
  request: VerifyProviderCredentialBindingRequest,
): Promise<ProviderCredentialBindingSummary> {
  return parseProviderCredentialBindingSummary(await invoke("verify_provider_credential_binding", {
    receiptId: request.receiptId,
  }));
}

export async function revokeProviderCredentialBinding(id: ProviderBindingId): Promise<void> {
  await invoke("revoke_provider_credential_binding", { id });
}
