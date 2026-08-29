// Pure state and text projections shared by the manual SQL workbench controller.
import type { ConnectionProfile } from "../connections/domain";
import type { AppErrorDetails, ExecOutcome } from "../../ipc/types";
import type { SqlParameter } from "../query/sqlParameters";
import type { SqlRunSource } from "./editorStatus";

export interface SqlWorkbenchRun {
  sql: string;
  outcome: ExecOutcome;
  at: string;
}

export interface SqlWorkbenchErrorInfo extends AppErrorDetails {
  sql: string;
  at: string;
}

export interface SqlWorkbenchLastAttempt {
  sql: string;
  at: string;
  documentVersion: number;
  source: SqlRunSource;
}

export type SqlWorkbenchResultKind = "single" | "script";

export interface SqlParameterDialogState {
  sql: string;
  source: SqlRunSource;
  parameters: SqlParameter[];
  action: "apply" | "explain" | "run";
}

export function wholeDocumentRunSource(draft: string): SqlRunSource | null {
  const sql = draft.trim();
  if (!sql) return null;
  const from = draft.indexOf(sql);
  return {
    sql,
    from,
    to: from + sql.length,
  };
}

export function buildSqlHelpPrompt({
  connection,
  database,
  namespace,
  sql,
  error,
}: {
  connection: ConnectionProfile;
  database: string;
  namespace: string;
  sql: string;
  error: SqlWorkbenchErrorInfo | null;
}) {
  const lines = [
    "DopeDB SQL context",
    "",
    `Connection: ${connection.name || "(unnamed)"}`,
    `Engine: ${connection.engine}`,
    `Database: ${database}`,
    `Schema: ${namespace}`,
    "",
    "SQL:",
    "```sql",
    sql.trim(),
    "```",
  ];
  if (error) {
    lines.push(
      "",
      "Error:",
      error.kind ? `Kind: ${error.kind}` : "Kind: unknown",
      `Message: ${error.message}`,
      "",
      "Raw error:",
      "```json",
      error.raw,
      "```",
    );
  }
  return lines.join("\n");
}
