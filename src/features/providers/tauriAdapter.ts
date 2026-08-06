// The sole frontend owner of local-provider command literals. Requests carry a
// short-lived receipt or a one-shot form value; no provider secret is retained here.
import { invoke } from "../../ipc/core";

import {
  parseProviderCredentialBindingSummary,
  parseProviderCredentialReceipt,
  parseProviderIntegrationSummary,
  parseProviderProvisioningDriverStatus,
  parseProviderProvisioningPlan,
  parseProviderProvisioningTarget,
  type BeginProviderCredentialBindingRequest,
  type ProviderBindingId,
  type ProviderCredentialBindingSummary,
  type ProviderCredentialReceipt,
  type ProviderIntegrationSummary,
  type ProviderKind,
  type ProviderProvisioningDriverStatus,
  type ProviderProvisioningPlan,
  type ProviderProvisioningTarget,
  type ProvisioningAccessMode,
  type ProvisioningDiscoveryId,
  type ProvisioningReceiptId,
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

export async function listProviderProvisioningStatuses(): Promise<ProviderProvisioningDriverStatus[]> {
  return arrayResponse(
    await invoke("list_provider_provisioning_statuses"),
    parseProviderProvisioningDriverStatus,
  );
}

export async function discoverProviderProvisioningTargets(
  provider: ProviderKind,
  connectionId: string,
): Promise<ProviderProvisioningTarget[]> {
  return arrayResponse(
    await invoke("discover_provider_provisioning_targets", { provider, connectionId }),
    parseProviderProvisioningTarget,
  );
}

export async function prepareProviderProvisioning(
  discoveryId: ProvisioningDiscoveryId,
  connectionId: string,
  access: ProvisioningAccessMode,
): Promise<ProviderProvisioningPlan> {
  return parseProviderProvisioningPlan(await invoke("prepare_provider_provisioning", {
    discoveryId,
    connectionId,
    access,
  }));
}

export async function getProviderProvisioningStatus(
  receiptId: ProvisioningReceiptId,
): Promise<ProviderProvisioningPlan> {
  return parseProviderProvisioningPlan(await invoke("get_provider_provisioning_status", {
    receiptId,
  }));
}

export async function listProviderProvisioningForConnection(
  connectionId: string,
): Promise<ProviderProvisioningPlan[]> {
  return arrayResponse(
    await invoke("list_provider_provisioning_for_connection", { connectionId }),
    parseProviderProvisioningPlan,
  );
}

export async function prepareProviderProvisioningDestroy(
  receiptId: ProvisioningReceiptId,
): Promise<ProviderProvisioningPlan> {
  return parseProviderProvisioningPlan(await invoke("prepare_provider_provisioning_destroy", {
    receiptId,
  }));
}

export async function prepareProviderProvisioningRepair(
  receiptId: ProvisioningReceiptId,
): Promise<ProviderProvisioningPlan> {
  return parseProviderProvisioningPlan(await invoke("prepare_provider_provisioning_repair", {
    receiptId,
  }));
}

export async function reconcileProviderProvisioning(
  receiptId: ProvisioningReceiptId,
): Promise<ProviderProvisioningPlan> {
  return parseProviderProvisioningPlan(await invoke("reconcile_provider_provisioning", {
    receiptId,
  }));
}

export async function executeProviderProvisioning(
  receiptId: ProvisioningReceiptId,
): Promise<ProviderProvisioningPlan> {
  return parseProviderProvisioningPlan(await invoke("execute_provider_provisioning", {
    receiptId,
  }));
}

export async function cancelProviderProvisioning(
  receiptId: ProvisioningReceiptId,
): Promise<void> {
  await invoke("cancel_provider_provisioning", { receiptId });
}
