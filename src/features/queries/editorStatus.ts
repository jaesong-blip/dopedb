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

export function sqlExecutionMarkerPosition(
  value: string,
  status: SqlExecutionStatus | null | undefined,
): number | null {
  const source = status?.source;
  if (
    !source ||
    !source.sql ||
    source.from < 0 ||
    source.to < source.from ||
    source.to > value.length ||
    value.slice(source.from, source.to).trim() !== source.sql
  ) {
    return null;
  }
  return source.to;
}
