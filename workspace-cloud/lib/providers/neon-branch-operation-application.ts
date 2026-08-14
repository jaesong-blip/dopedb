// Feature-owned dispatcher for durable Neon branch operations. Each resource
// use case owns its plan -> approval -> execution/reconciliation sequence.
import "server-only";

import type { NeonBranchOperationCommand } from "./neon-branch-operation-command";
import { NeonBranchDeletePlanError } from "./neon-branch-delete-plan";
import { NeonBranchPlanError } from "./neon-branch-plan";
import { NeonBranchSwitchPlanError } from "./neon-branch-switch-plan";
import { ProviderRequestError } from "./provider-types";
import {
  jsonError,
  type NeonBranchOperationContext,
  type NeonBranchOperationOutcome,
} from "./neon-branch-operations/contracts";
import { runNeonBranchCreateOperation } from "./neon-branch-operations/create";
import { runNeonBranchDeleteOperation } from "./neon-branch-operations/delete";
import { runNeonBranchSwitchOperation } from "./neon-branch-operations/switch";

export { listNeonBranchOperations } from "./neon-branch-operations/inventory";
export type {
  NeonBranchConnectionAuthorization,
  NeonBranchOperationOutcome,
} from "./neon-branch-operations/contracts";

export async function runNeonBranchOperation(
  input: NeonBranchOperationContext & Readonly<{
    body: NeonBranchOperationCommand;
  }>,
): Promise<NeonBranchOperationOutcome> {
  const { body } = input;
  try {
    switch (body.action) {
      case "planCreate":
      case "decideCreate":
      case "executeCreate":
        return await runNeonBranchCreateOperation(input, body);
      case "planDelete":
      case "decideDelete":
      case "executeDelete":
        return await runNeonBranchDeleteOperation(input, body);
      case "planSwitch":
      case "decideSwitch":
      case "executeSwitch":
        return await runNeonBranchSwitchOperation(input, body);
    }
  } catch (error) {
    if (error instanceof NeonBranchPlanError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof NeonBranchDeletePlanError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof NeonBranchSwitchPlanError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof ProviderRequestError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Neon branch operation request failed", 502);
  }
}
