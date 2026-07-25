import { invoke } from "@tauri-apps/api/core";

import type { ScriptOutcome } from "../../ipc/types";
import type { ConnectionId } from "../connections/domain";
import type {
  DdlPlan,
  SchemaChangeProposal,
  SchemaChangeRequest,
  SchemaOperationId,
} from "./domain";

export function previewSchemaChange(
  id: ConnectionId,
  request: SchemaChangeRequest,
): Promise<DdlPlan> {
  return invoke("preview_schema_change", { id, request });
}

export function proposeSchemaChange(
  id: ConnectionId,
  request: SchemaChangeRequest,
): Promise<SchemaChangeProposal> {
  return invoke("propose_schema_change", { id, request });
}

export function runSchemaChange(
  operationId: SchemaOperationId,
): Promise<ScriptOutcome> {
  return invoke("run_schema_change", { operationId });
}
