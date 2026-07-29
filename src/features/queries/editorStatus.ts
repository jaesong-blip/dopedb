export const SQL_EDITOR_INDENT_SIZE = 4;

export interface SqlCursorPosition {
  line: number;
  column: number;
}

export interface SqlEditorStatus extends SqlCursorPosition {
  documentId: string;
}

export type SqlExecutionState =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface SqlRunSource {
  sql: string;
  from: number;
  to: number;
}

export interface SqlExecutionStatus {
  source: SqlRunSource;
  state: SqlExecutionState;
  label: string;
}
