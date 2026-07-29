import { invoke } from "@tauri-apps/api/core";

import type {
  OperationDecision,
  ScriptOperationProposal,
  ScriptOutcome,
} from "../../ipc/types";

export function proposeTableChanges(
  connectionId: string,
  statements: string[],
  catalogFingerprint: string,
  database?: string,
): Promise<ScriptOperationProposal> {
  return invoke("propose_table_changes", {
    id: connectionId,
    database: database ?? null,
    statements,
    catalogFingerprint,
  });
}

export function approveTableChanges(
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

export function rejectTableChanges(
  operationId: string,
  payloadHash: string,
): Promise<OperationDecision> {
  return invoke("reject_operation", {
    operationId,
    payloadHash,
    reason: null,
  });
}

export function runTableChanges(operationId: string): Promise<ScriptOutcome> {
  return invoke("run_script", { operationId });
}
