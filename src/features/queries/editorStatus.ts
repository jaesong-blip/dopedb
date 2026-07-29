export const SQL_EDITOR_INDENT_SIZE = 4;

export interface SqlCursorPosition {
  line: number;
  column: number;
}

export interface SqlEditorStatus extends SqlCursorPosition {
  documentId: string;
}
