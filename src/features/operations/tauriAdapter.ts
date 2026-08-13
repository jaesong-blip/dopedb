// Approval decisions are shared across SQL, jobs, monitoring, and provider
// provisioning. This adapter is their single owner of operation command names.
import { invoke } from "../../ipc/core";
import type { OperationDecision } from "../../ipc/types";

export function approveOperation(
  operationId: string,
  payloadHash: string,
  reason?: string,
): Promise<OperationDecision> {
  return invoke("approve_operation", {
    operationId,
    payloadHash,
    reason: reason ?? null,
  });
}

export function rejectOperation(
  operationId: string,
  payloadHash: string,
  reason?: string,
): Promise<OperationDecision> {
  return invoke("reject_operation", {
    operationId,
    payloadHash,
    reason: reason ?? null,
  });
}
