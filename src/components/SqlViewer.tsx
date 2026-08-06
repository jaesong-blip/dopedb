// CodeMirror 6 SQL viewer/editor, shared by the Ask screen, ApprovalCard, and the SQL
// screen. Read-only by default; when a `catalog` is passed it feeds schema-aware
// autocomplete (table + column names), and `onRun` binds Mod-Enter to execute.
import { useCallback, useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import {
  MySQL,
  PostgreSQL,
  SQLite,
  StandardSQL,
  keywordCompletionSource,
  schemaCompletionSource,
  sql,
  type SQLDialect,
  type SQLNamespace,
} from "@codemirror/lang-sql";
import {
  autocompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  WidgetType,
  type ViewUpdate,
} from "@codemirror/view";
import type { Catalog } from "../ipc/types";
import type { ConnectionEngine } from "../features/connections/domain";
import {
  SQL_EDITOR_INDENT_SIZE,
  type SqlCursorPosition,
  type SqlExecutionStatus,
  type SqlRunSource,
} from "../features/queries/editorStatus";
import {
  DEFAULT_SQL_RESOLVE_MODE,
  resolveSqlNamespaceAtCaret,
  type SqlResolveMode,
} from "../features/queries/resolveMode";

// Catalog → CodeMirror schema map. Namespaced tables stay below their schema so
// `defaultSchema` controls which ones complete as bare names. Registering every
// PostgreSQL table at the root would leak candidates from unrelated schemas.
function buildSchema(catalog: Catalog): SQLNamespace {
  const ns: Record<string, SQLNamespace> = {};
  for (const t of catalog.tables) {
    const cols = t.columns.map((c) => c.name);
    if (t.schema) {
      const s = (ns[t.schema] ??= {}) as Record<string, SQLNamespace>;
      s[t.name] = cols;
    } else {
      ns[t.name] = cols;
    }
  }
  return ns;
}

function editorDialect(engine: ConnectionEngine | undefined): SQLDialect {
  if (engine === "postgres") return PostgreSQL;
  if (engine === "mysql") return MySQL;
  if (engine === "sqlite") return SQLite;
  return StandardSQL;
}

export interface SqlViewerProps {
  value: string;
  editable?: boolean;
  onChange?: (v: string) => void;
  onRun?: (source?: SqlRunSource) => void;
  catalog?: Catalog;
  engine?: ConnectionEngine;
  resolveMode?: SqlResolveMode;
  defaultSchema?: string;
  namespaceOptions?: readonly string[];
  minHeight?: string;
  onCursorChange?: (position: SqlCursorPosition) => void;
  onBlur?: () => void;
  executionStatus?: SqlExecutionStatus | null;
  /** Receives the production CodeMirror view for deterministic packaged profiling. */
  onEditorReady?: (view: EditorView) => void;
}

function cursorPosition(state: EditorState): SqlCursorPosition {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return {
    line: line.number,
    column: head - line.from + 1,
  };
}

function selectedRunSource(state: EditorState): SqlRunSource | undefined {
  const selection = state.selection.main;
  if (selection.empty) return undefined;
  const raw = state.sliceDoc(selection.from, selection.to);
  const sql = raw.trim();
  const leadingWhitespace = raw.length - raw.trimStart().length;
  const trailingWhitespace = raw.length - raw.trimEnd().length;
  return {
    sql,
    from: selection.from + leadingWhitespace,
    to: selection.to - trailingWhitespace,
  };
}

class SqlExecutionWidget extends WidgetType {
  constructor(private readonly status: SqlExecutionStatus) {
    super();
  }

  eq(other: SqlExecutionWidget): boolean {
    return (
      this.status.state === other.status.state &&
      this.status.label === other.status.label
    );
  }

  toDOM(): HTMLElement {
    const root = document.createElement("span");
    root.dataset.state = this.status.state;
    root.className =
      "tw:ml-3 tw:inline-flex tw:select-none tw:items-center tw:gap-1.5 tw:font-sans tw:text-xs tw:text-muted-foreground tw:data-[state=completed]:text-success tw:data-[state=failed]:text-danger tw:data-[state=waiting]:text-warning";
    root.title = this.status.label;
    root.setAttribute("aria-label", this.status.label);

    const mark = document.createElement("span");
    mark.className = "tw:font-bold";
    mark.textContent =
      this.status.state === "completed"
        ? "✓"
        : this.status.state === "failed"
          ? "!"
          : this.status.state === "cancelled"
            ? "■"
            : "●";

    const label = document.createElement("span");
    label.textContent = this.status.label;
    root.append(mark, label);
    return root;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function executionStatusExtension(
  value: string,
  status: SqlExecutionStatus | null | undefined,
): Extension {
  const source = status?.source;
  if (
    !status ||
    !source ||
    !source.sql ||
    source.from < 0 ||
    source.to < source.from ||
    source.to > value.length ||
    value.slice(source.from, source.to).trim() !== source.sql
  ) {
    return [];
  }
  return EditorView.decorations.of(
    Decoration.set([
      Decoration.widget({
        widget: new SqlExecutionWidget(status),
        side: 1,
      }).range(source.to),
    ]),
  );
}

export default function SqlViewer({
  value,
  editable = false,
  onChange,
  onRun,
  catalog,
  engine,
  resolveMode = DEFAULT_SQL_RESOLVE_MODE,
  defaultSchema,
  namespaceOptions = [],
  minHeight = "80px",
  onCursorChange,
  onBlur,
  executionStatus,
  onEditorReady,
}: SqlViewerProps) {
  const extensions = useMemo(() => {
    const dialect = editorDialect(engine);
    const ext = [
      sql({ dialect }),
      EditorView.lineWrapping,
    ];
    if (catalog) {
      const schema = buildSchema(catalog);
      const schemaCompletion: CompletionSource = (context) => {
        const resolvedDefaultSchema = defaultSchema
          ? resolveSqlNamespaceAtCaret({
              sqlBeforeCaret: context.state.sliceDoc(0, context.pos),
              engine: engine ?? "sqlite",
              mode: resolveMode,
              selectedNamespace: defaultSchema,
              namespaceOptions,
            })
          : undefined;
        return schemaCompletionSource({
          dialect,
          schema,
          defaultSchema: resolvedDefaultSchema,
        })(context);
      };
      ext.push(
        autocompletion({
          override: [
            schemaCompletion,
            keywordCompletionSource(dialect, true),
          ],
        }),
      );
    }
    if (onRun) {
      ext.push(
        keymap.of([
          {
            key: "Mod-Enter",
            run: (view) => {
              // Run just the selection when there is one; otherwise the whole draft.
              onRun(selectedRunSource(view.state));
              return true;
            },
          },
        ]),
      );
    }
    if (onBlur) {
      ext.push(
        EditorView.domEventHandlers({
          blur: () => {
            onBlur();
            return false;
          },
        }),
      );
    }
    return ext;
  }, [
    catalog,
    defaultSchema,
    engine,
    namespaceOptions,
    onBlur,
    onRun,
    resolveMode,
  ]);
  const reportCursor = useCallback(
    (state: EditorState) => {
      onCursorChange?.(cursorPosition(state));
    },
    [onCursorChange],
  );
  const handleCreateEditor = useCallback(
    (view: EditorView) => {
      reportCursor(view.state);
      onEditorReady?.(view);
    },
    [onEditorReady, reportCursor],
  );
  const handleUpdate = useCallback(
    (update: ViewUpdate) => {
      if (!onCursorChange || !update.selectionSet) return;
      reportCursor(update.state);
    },
    [onCursorChange, reportCursor],
  );
  const executionValue = executionStatus ? value : "";
  const executionExtension = useMemo(
    () => executionStatusExtension(executionValue, executionStatus),
    [executionStatus, executionValue],
  );
  const allExtensions = useMemo(
    () => [...extensions, executionExtension],
    [executionExtension, extensions],
  );

  return (
    <CodeMirror
      value={value}
      theme="dark"
      editable={editable}
      readOnly={!editable}
      onChange={onChange}
      onCreateEditor={handleCreateEditor}
      onUpdate={handleUpdate}
      extensions={allExtensions}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        tabSize: SQL_EDITOR_INDENT_SIZE,
      }}
      className="tw:text-ui"
      style={{ minHeight }}
    />
  );
}
