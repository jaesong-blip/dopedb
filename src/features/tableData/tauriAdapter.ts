import { invoke } from "../../ipc/core";

import type { ScriptOperationProposal } from "../../ipc/types";

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
