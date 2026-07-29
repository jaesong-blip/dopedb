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
import { type EditorState } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import type { Catalog } from "../ipc/types";
import type { ConnectionEngine } from "../features/connections/domain";
import {
  SQL_EDITOR_INDENT_SIZE,
  type SqlCursorPosition,
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
  onRun?: (selectedSql?: string) => void;
  catalog?: Catalog;
  engine?: ConnectionEngine;
  resolveMode?: SqlResolveMode;
  defaultSchema?: string;
  namespaceOptions?: readonly string[];
  minHeight?: string;
  onCursorChange?: (position: SqlCursorPosition) => void;
}

function cursorPosition(state: EditorState): SqlCursorPosition {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return {
    line: line.number,
    column: head - line.from + 1,
  };
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
              const sel = view.state.selection.main;
              const picked = sel.empty ? undefined : view.state.sliceDoc(sel.from, sel.to);
              onRun(picked);
              return true;
            },
          },
        ]),
      );
    }
    return ext;
  }, [
    catalog,
    defaultSchema,
    engine,
    namespaceOptions,
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
    },
    [reportCursor],
  );
  const handleUpdate = useCallback(
    (update: ViewUpdate) => {
      if (!onCursorChange || (!update.selectionSet && !update.docChanged)) {
        return;
      }
      reportCursor(update.state);
    },
    [onCursorChange, reportCursor],
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
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        tabSize: SQL_EDITOR_INDENT_SIZE,
      }}
      style={{ minHeight, fontSize: "13px" }}
    />
  );
}
