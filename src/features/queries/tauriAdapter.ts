// The only frontend module that owns SQL query command literals and their camelCase wire shape.
// Mutating execution stays behind the explicit proposal/approval/run flow.

import { invoke } from "@tauri-apps/api/core";

import type { ExecOutcome } from "../../ipc/types";
import type { SqlInspection, SqlOperationProposal } from "./domain";

export function inspectSql(id: string, sql: string): Promise<SqlInspection> {
  return invoke("inspect_sql", { id, sql });
}

export function proposeSql(
  id: string,
  sql: string,
  origin?: string,
): Promise<SqlOperationProposal> {
  return invoke("propose_sql", {
    id,
    sql,
    origin: origin ?? null,
  });
}

export function runSql(operationId: string): Promise<ExecOutcome> {
  return invoke("run_sql", { operationId });
}

// Plan and consume a SQL read without exposing an approval shortcut. Callers that may generate
// mutations must use the explicit proposal/approval/run sequence.
export async function runSqlRead(
  id: string,
  sql: string,
  origin?: string,
): Promise<ExecOutcome> {
  const proposal = await proposeSql(id, sql, origin);
  if (proposal.approvalRequired || proposal.classification.kind !== "read") {
    throw new Error("read execution helper rejected a target-mutating proposal");
  }
  return runSql(proposal.operationId);
}
