// Manual SQL console. Editable CodeMirror. Run is the human approval action;
// execution sessions and Output/Result live in the shell-owned Services window.
// Multi-statement scripts execute through the backend script runner and preserve
// per-statement results. ⌘↩ runs the current draft or selected SQL.
import { useEffect, useMemo, useRef, useState } from "react";
import type { SqlLanguage } from "sql-formatter";
import { useQuery } from "@tanstack/react-query";
import {
  approveOperation,
  proposeScript,
  rejectOperation,
  runScript,
} from "../../ipc/commands";
import type {
  AppErrorDetails,
  ExecOutcome,
  SafetySettings,
  ScriptOperationProposal,
  ScriptOutcome,
} from "../../ipc/types";
import { errDetails, errMessage } from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import {
  inspectSql,
  proposeSql,
  runSql as runSqlOperation,
  runSqlReadStream,
  runSqlStream,
} from "../../features/queries/tauriAdapter";
import ManualTransactionControls from "../../features/queries/ManualTransactionControls";
import { useManualTransaction } from "../../features/queries/useManualTransaction";
import {
  effectiveSqlNamespace,
  sqlNamespaceOptions,
} from "../../features/queries/namespace";
import type { SqlResolveMode } from "../../features/queries/resolveMode";
import type {
  SqlCursorPosition,
  SqlExecutionStatus,
  SqlRunSource,
} from "../../features/queries/editorStatus";
import { useSqlResultStream } from "../../features/queries/useSqlResultStream";
import type {
  PreviewReport,
  SqlOperationProposal,
} from "../../features/queries/domain";
import {
  nextQueryServiceSessionId,
  type QueryServiceResult,
  type QueryServiceSession,
} from "../../features/queryServices/domain";
import {
  connectionId,
  sqlDocumentId,
  type SqlDocument,
} from "../../features/sqlDocuments/domain";
import { tauriSqlDocumentGateway } from "../../features/sqlDocuments/tauriAdapter";
import { useSqlDocumentAutosave } from "../../features/sqlDocuments/useSqlDocumentAutosave";
import { localizeRunSignal } from "../../features/query/runSignal";
import { useSqlDraftAnalysis } from "../../features/query/useSqlDraftAnalysis";
import { formatSqlDocument } from "../../features/query/sqlFormatter";
import { useSqlEditorBuffer } from "../../features/query/useSqlEditorBuffer";
import {
  publishWorkbenchDraft,
  useWorkbenchDraft,
} from "../../features/workbench/draftStore";
import {
  findSqlParameters,
  materializeSqlParameters,
  type SqlParameter,
} from "../../features/query/sqlParameters";
import ApprovalCard from "../../components/ApprovalCard";
import { Icon } from "../../components/Icon";
import LazySqlViewer from "../../components/LazySqlViewer";
import {
  WorkbenchButton,
  WorkbenchContainedBody,
  WorkbenchDivider,
  WorkbenchPane,
  WorkbenchSelect,
  WorkbenchToolbar,
} from "../../design-system/components/Workbench";
import { StatusBadge } from "../../design-system/components/Status";
import { useI18n } from "../../lib/i18n";
import { useEventCallback } from "../../lib/useEventCallback";
import {
  connectionDatabasesQuery,
  databaseCatalogQuery,
  useCatalogScope,
} from "../../lib/queries";
import { splitStatements } from "../../lib/sqlStatements";
import { useQueryRun } from "../../lib/useQueryRun";
import {
  clearSqlEditorCursor,
  publishSqlEditorCursor,
} from "../../features/queries/editorStatusStore";
import {
  canFallbackFromCombinedRead,
  initialSqlRunPath,
  proposalSqlRunPath,
} from "./runPath";
import SqlParameterDialog from "./SqlParameterDialog";

interface Run {
  sql: string;
  outcome: ExecOutcome;
  at: string;
}

interface QueryErrorInfo extends AppErrorDetails {
  sql: string;
  at: string;
}

interface LastAttempt {
  sql: string;
  at: string;
  documentVersion: number;
  source: SqlRunSource;
}

interface PendingSqlApproval {
  proposal: SqlOperationProposal;
  sql: string;
  at: string;
}

interface PendingScriptApproval {
  proposal: ScriptOperationProposal;
  sql: string;
  at: string;
}

type ResultKind = "single" | "script";

interface ParameterDialogState {
  sql: string;
  source: SqlRunSource;
  parameters: SqlParameter[];
  action: "apply" | "explain" | "run";
}

function wholeDocumentRunSource(draft: string): SqlRunSource | null {
  const sql = draft.trim();
  if (!sql) return null;
  const from = draft.indexOf(sql);
  return {
    sql,
    from,
    to: from + sql.length,
  };
}

function buildSqlHelpPrompt({
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
  error: QueryErrorInfo | null;
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

export default function Sql({
  connection,
  documentId,
  safety,
  safetyReady,
  safetyLoadError,
  draft: draftSnapshot,
  title,
  setTitle,
  selectedDatabase,
  setSelectedDatabase,
  selectedSchema,
  setSelectedSchema,
  resolveMode,
  setResolveMode,
  persistedId,
  revision,
  recovered,
  onPersisted,
  onQueryServiceSessionChange,
  onShowQueryServices,
  onOpenHistory,
  onRetrySafety,
}: {
  connection: ConnectionProfile;
  documentId: string;
  safety: SafetySettings;
  safetyReady: boolean;
  safetyLoadError: string | null;
  draft: string;
  title: string;
  setTitle: (title: string) => void;
  selectedDatabase: string;
  setSelectedDatabase: (selectedDatabase: string) => void;
  selectedSchema: string | null;
  setSelectedSchema: (selectedSchema: string | null) => void;
  resolveMode: SqlResolveMode;
  setResolveMode: (resolveMode: SqlResolveMode) => void;
  persistedId: string | null;
  revision: number;
  recovered: boolean;
  onPersisted: (document: SqlDocument) => void;
  onQueryServiceSessionChange: (session: QueryServiceSession) => void;
  onShowQueryServices: (sessionId: string) => void;
  onOpenHistory: () => void;
  onRetrySafety: () => void;
}) {
  const { t } = useI18n();
  const shellSnapshot = useWorkbenchDraft(documentId, draftSnapshot);
  const {
    draft,
    draftVersion,
    setDraft,
    flushSnapshot: flushDraftSnapshot,
  } = useSqlEditorBuffer({
    documentId,
    snapshot: shellSnapshot,
    onSnapshot: publishWorkbenchDraft,
  });
  const draftAnalysis = useSqlDraftAnalysis({
    sql: draft,
    version: draftVersion,
    engine: connection.engine,
    safety,
  });
  const analysisCurrent = draftAnalysis.version === draftVersion;
  const draftIsScript = analysisCurrent && draftAnalysis.statementCount > 1;
  const draftParameterCount = analysisCurrent
    ? draftAnalysis.parameterCount
    : 0;
  const draftSignal = useMemo(
    () =>
      analysisCurrent ? localizeRunSignal(draftAnalysis.runSignal, t) : null,
    [analysisCurrent, draftAnalysis.runSignal, t],
  );

  const [resultKind, setResultKind] = useState<ResultKind | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const {
    stream,
    start: startDesktopStream,
    cancel: cancelDesktopStream,
    reset: resetDesktopStream,
  } = useSqlResultStream(connection.id);
  const [scriptOut, setScriptOut] = useState<{
    outcome: ScriptOutcome;
    at: string;
  } | null>(null);
  const { running, cancelled, execute, cancel, track } = useQueryRun();
  const [runErr, setRunErr] = useState<QueryErrorInfo | null>(null);
  const [lastAttempt, setLastAttempt] = useState<LastAttempt | null>(null);
  const [pendingApproval, setPendingApproval] =
    useState<PendingSqlApproval | null>(null);
  const [pendingScriptApproval, setPendingScriptApproval] =
    useState<PendingScriptApproval | null>(null);
  const [approvalRejected, setApprovalRejected] = useState(false);
  const [scriptConfirmation, setScriptConfirmation] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [parameterValues, setParameterValues] = useState<
    Record<string, string>
  >({});
  const [parameterDialog, setParameterDialog] =
    useState<ParameterDialogState | null>(null);
  const serviceSessionRef = useRef<
    Omit<QueryServiceSession, "status" | "result" | "updatedAt"> | undefined
  >(undefined);

  // EXPLAIN plan (read-only preview) shown above the results, independent of execution.
  const [plan, setPlan] = useState<PreviewReport | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const catalogScope = useCatalogScope();
  const databasesQuery = useQuery(
    connectionDatabasesQuery(connection.id, catalogScope),
  );
  const databaseOptions = useMemo(() => {
    if (!databasesQuery.data) {
      return [selectedDatabase || connection.database].filter(Boolean);
    }
    const names = databasesQuery.data?.map((database) => database.name) ?? [];
    return names.includes(connection.database)
      ? names
      : [connection.database, ...names].filter(Boolean);
  }, [connection.database, databasesQuery.data, selectedDatabase]);
  const effectiveDatabase = databaseOptions.includes(selectedDatabase)
    ? selectedDatabase
    : (databaseOptions[0] ?? connection.database);
  const targetConnection = useMemo(
    () => ({ ...connection, database: effectiveDatabase }),
    [connection, effectiveDatabase],
  );
  const catalogQueryResult = useQuery(
    databaseCatalogQuery(connection.id, effectiveDatabase, catalogScope),
  );
  const catalog = catalogQueryResult.data;
  const namespaceOptions = useMemo(
    () => sqlNamespaceOptions(targetConnection, catalog),
    [catalog, targetConnection],
  );
  const effectiveNamespace = useMemo(
    () =>
      effectiveSqlNamespace(targetConnection, selectedSchema, namespaceOptions),
    [namespaceOptions, selectedSchema, targetConnection],
  );
  const manualTransaction = useManualTransaction(
    connection.id,
    effectiveDatabase,
  );

  useEffect(() => {
    if (!databasesQuery.data) return;
    if (!effectiveDatabase || selectedDatabase === effectiveDatabase) return;
    setSelectedDatabase(effectiveDatabase);
  }, [
    databasesQuery.data,
    effectiveDatabase,
    selectedDatabase,
    setSelectedDatabase,
  ]);

  useEffect(() => {
    if (!catalogQueryResult.data) return;
    if (!effectiveNamespace || selectedSchema === effectiveNamespace) return;
    setSelectedSchema(effectiveNamespace);
  }, [
    catalogQueryResult.data,
    effectiveNamespace,
    selectedSchema,
    setSelectedSchema,
  ]);
  const resolveModeHint =
    resolveMode === "script"
      ? t("sql.resolveModeScriptHint")
      : t("sql.resolveModePlaygroundHint");

  const {
    saveState: documentSaveState,
    saveError: documentSaveError,
    conflict: documentConflict,
    useSavedVersion: loadSavedConflictVersion,
    keepLocalVersion: keepLocalConflictVersion,
    reportError: reportDocumentSaveError,
    flushRecovery,
  } = useSqlDocumentAutosave({
    gateway: tauriSqlDocumentGateway,
    connectionId: connectionId(connection.id),
    documentId: persistedId ? sqlDocumentId(persistedId) : null,
    revision,
    title,
    selectedDatabase: effectiveDatabase,
    selectedSchema,
    resolveMode,
    content: draft,
    recovered,
    onTitleChange: setTitle,
    onSelectedDatabaseChange: setSelectedDatabase,
    onSelectedSchemaChange: setSelectedSchema,
    onResolveModeChange: setResolveMode,
    onContentChange: setDraft,
    onPersisted,
  });
  const flushEditorState = useEventCallback(() => {
    flushDraftSnapshot();
    flushRecovery();
  });
  const handleCursorChange = useEventCallback((position: SqlCursorPosition) => {
    publishSqlEditorCursor(documentId, position);
  });

  useEffect(() => () => clearSqlEditorCursor(documentId), [documentId]);

  async function formatDraft() {
    if (!draft.trim() || formatting) return;
    setFormatting(true);
    try {
      const language: SqlLanguage =
        connection.engine === "postgres"
          ? "postgresql"
          : connection.engine === "mysql"
            ? "mysql"
            : "sqlite";
      setDraft(await formatSqlDocument(draft, language));
    } catch (error) {
      reportDocumentSaveError(error);
    } finally {
      setFormatting(false);
    }
  }

  async function runSql(sql: string, source: SqlRunSource) {
    if (!sql || running || !safetyReady) return;
    flushEditorState();
    globalThis.performance?.clearMarks?.("desktop_query_interaction_start");
    globalThis.performance?.mark?.("desktop_query_interaction_start");

    const statements = splitStatements(sql);
    const script = statements.length > 1;
    const at = new Date().toLocaleTimeString();
    const sessionId = nextQueryServiceSessionId(documentId);
    serviceSessionRef.current = {
      schemaVersion: 2,
      id: sessionId,
      documentId,
      connectionId: connection.id,
      connectionName: connection.name,
      consoleTitle: title,
      database: effectiveDatabase,
      namespace: effectiveNamespace,
      sql,
      startedAt: new Date().toISOString(),
      startedLabel: at,
    };
    onQueryServiceSessionChange({
      ...serviceSessionRef.current,
      updatedAt: Date.now(),
      status: "running",
      result: { kind: "none" },
    });
    onShowQueryServices(sessionId);
    setRunErr(null);
    setApprovalRejected(false);
    setPendingApproval(null);
    setPendingScriptApproval(null);
    setRun(null);
    setScriptOut(null);
    setResultKind(script ? "script" : "single");
    setLastAttempt({ sql, at, documentVersion: draftVersion, source });

    try {
      await execute(async () => {
        await resetDesktopStream();
        if (script) {
          const proposal = await proposeScript(
            connection.id,
            sql,
            "manual",
            effectiveNamespace,
            effectiveDatabase,
          );
          if (proposal.approvalRequired) {
            setPendingScriptApproval({ proposal, sql, at });
            setScriptConfirmation("");
            return;
          }
          track(proposal.operationId);
          const outcome = await runScript(proposal.operationId);
          setScriptOut({ outcome, at });
        } else {
          const runPlannedSql = async () => {
            const proposal = await proposeSql(
              connection.id,
              sql,
              "manual",
              effectiveNamespace,
              effectiveDatabase,
            );
            if (proposalSqlRunPath(proposal) === "approval") {
              setPendingApproval({ proposal, sql, at });
              return;
            }
            setRun(null);
            if (manualTransaction.status) {
              setRun({
                sql,
                outcome: await runSqlOperation(proposal.operationId),
                at: new Date().toLocaleTimeString(),
              });
            } else {
              await startDesktopStream((onBatch) =>
                runSqlStream(proposal.operationId, onBatch),
              );
            }
          };
          if (
            !manualTransaction.status &&
            initialSqlRunPath(safety.autoRunReads) === "combinedReadStream"
          ) {
            try {
              // Exactly one IPC for auto reads. Only the backend's typed,
              // pre-target `proposalRequired` signal may enter the proposal UI.
              setRun(null);
              await startDesktopStream((onBatch) =>
                runSqlReadStream(
                  connection.id,
                  sql,
                  onBatch,
                  "manual",
                  effectiveNamespace,
                  effectiveDatabase,
                ),
              );
            } catch (error) {
              if (!canFallbackFromCombinedRead(errDetails(error).kind))
                throw error;
              await resetDesktopStream();
              await runPlannedSql();
            }
          } else {
            // Manual/read-only settings still stream after the durable proposal;
            // approved write/DDL returns its bounded materialized outcome.
            await runPlannedSql();
          }
        }
      });
    } catch (e) {
      if (!script && stream.phase === "cancelled") return;
      const details = errDetails(e);
      setRunErr({ ...details, sql, at: new Date().toLocaleTimeString() });
      // Clear the attempted kind so a failed run can't leave the previous
      // result sitting under the error card looking current.
      if (script) setScriptOut(null);
      else {
        setRun(null);
      }
    }
  }

  function executeSql(selectedSource?: SqlRunSource) {
    const source = selectedSource ?? wholeDocumentRunSource(draft);
    if (!source?.sql || running || !safetyReady) return;
    const parameters = findSqlParameters(source.sql, connection.engine);
    if (parameters.length > 0) {
      setParameterDialog({
        sql: source.sql,
        source,
        parameters,
        action: "run",
      });
      return;
    }
    void runSql(source.sql, source);
  }
  const executeSqlFromEditor = useEventCallback(executeSql);

  function openParameterDialog() {
    const parameters = findSqlParameters(draft, connection.engine);
    if (parameters.length === 0) return;
    setParameterDialog({
      sql: draft,
      source: wholeDocumentRunSource(draft) ?? {
        sql: draft,
        from: 0,
        to: draft.length,
      },
      parameters,
      action: "apply",
    });
  }

  function applyParameterValues(values: Record<string, string>) {
    const pending = parameterDialog;
    if (!pending) return;
    const sql = materializeSqlParameters(
      pending.sql,
      pending.parameters,
      values,
    );
    setParameterValues(values);
    setParameterDialog(null);
    if (pending.action === "run") void runSql(sql, pending.source);
    else if (pending.action === "explain") void explainSql(sql);
  }

  async function approvePendingScript() {
    const pending = pendingScriptApproval;
    if (!pending || running) return;
    try {
      await execute(async () => {
        track(pending.proposal.operationId);
        await approveOperation(
          pending.proposal.operationId,
          pending.proposal.payloadHash,
          pending.proposal.confirmationPhrase ? scriptConfirmation : undefined,
        );
        const outcome = await runScript(pending.proposal.operationId);
        setResultKind("script");
        setScriptOut({ outcome, at: new Date().toLocaleTimeString() });
        setPendingScriptApproval(null);
        setScriptConfirmation("");
      });
    } catch (e) {
      const details = errDetails(e);
      setRunErr({
        ...details,
        sql: pending.sql,
        at: new Date().toLocaleTimeString(),
      });
    }
  }

  async function rejectPendingScript() {
    const pending = pendingScriptApproval;
    if (!pending || running) return;
    try {
      await rejectOperation(
        pending.proposal.operationId,
        pending.proposal.payloadHash,
      );
      setApprovalRejected(true);
      setPendingScriptApproval(null);
      setScriptConfirmation("");
    } catch (e) {
      const details = errDetails(e);
      setRunErr({
        ...details,
        sql: pending.sql,
        at: new Date().toLocaleTimeString(),
      });
    }
  }

  async function explainSql(sql: string) {
    if (!sql.trim() || splitStatements(sql).length > 1 || explaining) return;
    setPlanErr(null);
    setExplaining(true);
    try {
      // One backend inspection owns classification, authority pinning, and the
      // read-only Explain. There is no classify-to-preview IPC race to bridge.
      const inspection = await inspectSql(
        connection.id,
        sql,
        effectiveNamespace,
        effectiveDatabase,
      );
      setPlan(inspection.report);
    } catch (e) {
      setPlanErr(errMessage(e));
      setPlan(null);
    } finally {
      setExplaining(false);
    }
  }

  function explain() {
    if (!draft.trim() || explaining) return;
    if (splitStatements(draft).length > 1) return;
    const parameters = findSqlParameters(draft, connection.engine);
    if (parameters.length > 0) {
      setParameterDialog({
        sql: draft,
        source: wholeDocumentRunSource(draft) ?? {
          sql: draft,
          from: 0,
          to: draft.length,
        },
        parameters,
        action: "explain",
      });
      return;
    }
    void explainSql(draft);
  }

  // A plan describes the draft it was generated from — invalidate it on edit.
  useEffect(() => {
    setPlan(null);
    setPlanErr(null);
  }, [draftVersion]);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const aiPrompt = useMemo(
    () =>
      runErr
        ? buildSqlHelpPrompt({
            connection,
            database: effectiveDatabase,
            namespace: effectiveNamespace,
            sql: lastAttempt?.sql ?? runErr.sql,
            error: runErr,
          })
        : "",
    [
      connection,
      effectiveDatabase,
      effectiveNamespace,
      lastAttempt?.sql,
      runErr,
    ],
  );
  const editorExecutionStatus = useMemo<SqlExecutionStatus | null>(() => {
    const attempt = lastAttempt;
    const sql = attempt?.sql.trim();
    if (!attempt || !sql || attempt.documentVersion !== draftVersion)
      return null;
    if (runErr) {
      return {
        source: attempt.source,
        state: "failed",
        label: t("services.status.failed"),
      };
    }
    if (pendingApproval || pendingScriptApproval) {
      return {
        source: attempt.source,
        state: "waiting",
        label: t("services.status.waiting"),
      };
    }
    if (
      running ||
      stream.phase === "connecting" ||
      stream.phase === "streaming"
    ) {
      return {
        source: attempt.source,
        state: "running",
        label: t("sql.runningFor", { seconds: elapsed }),
      };
    }
    if (approvalRejected || cancelled || stream.phase === "cancelled") {
      return {
        source: attempt.source,
        state: "cancelled",
        label: t("services.status.cancelled"),
      };
    }
    const durationMs =
      stream.durationMs ?? run?.outcome.result?.durationMs ?? null;
    if (scriptOut || run || stream.phase === "complete") {
      return {
        source: attempt.source,
        state: "completed",
        label:
          durationMs === null
            ? t("services.status.completed")
            : `${Math.round(durationMs)} ms`,
      };
    }
    return null;
  }, [
    approvalRejected,
    cancelled,
    draftVersion,
    elapsed,
    lastAttempt?.documentVersion,
    lastAttempt?.source,
    lastAttempt?.sql,
    pendingApproval,
    pendingScriptApproval,
    run,
    runErr,
    running,
    scriptOut,
    stream.durationMs,
    stream.phase,
    t,
  ]);

  useEffect(() => {
    const session = serviceSessionRef.current;
    if (!session) return;

    let result: QueryServiceResult = { kind: "none" };
    if (runErr) {
      result = { kind: "error", error: runErr, prompt: aiPrompt };
    } else if (resultKind === "script" && scriptOut) {
      result = {
        kind: "script",
        outcome: scriptOut.outcome,
        at: scriptOut.at,
      };
    } else if (resultKind === "single" && run) {
      result = {
        kind: "materialized",
        sql: run.sql,
        outcome: run.outcome,
        at: run.at,
        maxRows: safety.maxRows,
      };
    } else if (
      resultKind === "single" &&
      (stream.phase === "connecting" ||
        stream.phase === "streaming" ||
        stream.phase === "complete")
    ) {
      result = {
        kind: "stream",
        sql: lastAttempt?.sql ?? session.sql,
        stream,
        maxRows: safety.maxRows,
      };
    }

    const status = runErr
      ? "failed"
      : pendingApproval || pendingScriptApproval
        ? "waiting"
        : approvalRejected || cancelled || stream.phase === "cancelled"
          ? "cancelled"
          : running ||
              stream.phase === "connecting" ||
              stream.phase === "streaming"
            ? "running"
            : result.kind === "none"
              ? "running"
              : "completed";

    onQueryServiceSessionChange({
      ...session,
      updatedAt: Date.now(),
      status,
      result,
    });
  }, [
    aiPrompt,
    approvalRejected,
    cancelled,
    lastAttempt?.sql,
    onQueryServiceSessionChange,
    pendingApproval,
    pendingScriptApproval,
    resultKind,
    run,
    runErr,
    running,
    safety.maxRows,
    scriptOut,
    stream,
  ]);

  return (
    <WorkbenchPane>
      <WorkbenchToolbar label={t("sql.documentTitle")} compact>
        <div className="ds-control-row scrollbar-sleek tw:flex tw:min-h-0 tw:min-w-0 tw:flex-[0_1_auto] tw:flex-nowrap tw:items-center tw:gap-1 tw:overflow-x-auto tw:overflow-y-hidden tw:max-[760px]:shrink-0">
          <WorkbenchButton
            iconOnly
            tone="success"
            disabled={draft.length === 0 || running || !safetyReady}
            onClick={() => void executeSql()}
            title={t("sql.runHint")}
            aria-label={running ? t("sql.running") : t("sql.run")}
          >
            <Icon name={running ? "refresh" : "play"} />
          </WorkbenchButton>
          <WorkbenchButton
            iconOnly
            onClick={onOpenHistory}
            title={t("sql.history")}
            aria-label={t("sql.history")}
          >
            <Icon name="history" />
          </WorkbenchButton>
          <WorkbenchButton
            iconOnly
            disabled={!analysisCurrent || draftParameterCount === 0 || running}
            onClick={openParameterDialog}
            title={
              draftParameterCount > 0
                ? t("sql.viewParametersCount", {
                    count: draftParameterCount,
                  })
                : t("sql.noParameters")
            }
            aria-label={t("sql.viewParameters")}
          >
            <Icon name="parameter" />
          </WorkbenchButton>
          <WorkbenchButton
            iconOnly
            disabled={
              draft.length === 0 ||
              !analysisCurrent ||
              draftIsScript ||
              explaining ||
              running ||
              !safetyReady
            }
            title={
              draftIsScript ? t("sql.explainSingle") : t("sql.explainTitle")
            }
            aria-label={t("sql.explain")}
            onClick={explain}
          >
            <Icon name={explaining ? "refresh" : "target"} />
          </WorkbenchButton>
          <WorkbenchButton
            iconOnly
            disabled={draft.length === 0 || formatting || running}
            onClick={() => void formatDraft()}
            title={t("sql.formatTitle")}
            aria-label={t("sql.format")}
          >
            <Icon name={formatting ? "refresh" : "list"} />
          </WorkbenchButton>
          <WorkbenchDivider />
          {!safetyReady ? (
            <button
              type="button"
              className="badge tw:cursor-pointer tw:border-warning tw:bg-transparent tw:text-warning"
              onClick={onRetrySafety}
              title={safetyLoadError ?? t("sql.safetyLoading")}
            >
              <Icon name={safetyLoadError ? "alert" : "refresh"} />
              {safetyLoadError ? t("sql.retrySafety") : t("sql.safetyLoading")}
            </button>
          ) : (
            <ManualTransactionControls
              controller={manualTransaction}
              writesEnabled={safety.allowWrites}
              writesDisabledHint={
                safety.allowWrites ? undefined : t("sql.txManualWritesRequired")
              }
              disabled={running}
            />
          )}
          <WorkbenchButton
            iconOnly
            disabled={!running}
            onClick={() => {
              cancel();
              void cancelDesktopStream();
            }}
            title={
              running
                ? `${t("sql.cancel")} · ${t("sql.runningFor", {
                    seconds: elapsed,
                  })}`
                : t("sql.cancel")
            }
            aria-label={t("sql.cancel")}
          >
            <Icon name="stop" />
          </WorkbenchButton>
          <WorkbenchSelect
            label={t("sql.resolveMode")}
            title={resolveModeHint}
            value={resolveMode}
            disabled={running}
            onChange={(value) => setResolveMode(value as SqlResolveMode)}
          >
            <option value="playground">{t("sql.resolveModePlayground")}</option>
            <option value="script">{t("sql.resolveModeScript")}</option>
          </WorkbenchSelect>
          {!running && draftSignal && draftSignal.tone !== "muted" ? (
            <span
              data-tone={draftSignal.tone}
              className="badge icon-only-badge tw:data-[tone=danger]:border-danger tw:data-[tone=danger]:text-danger tw:data-[tone=warning]:border-warning tw:data-[tone=warning]:text-warning"
              title={draftSignal.title ?? draftSignal.text}
              aria-label={draftSignal.text}
              role="img"
            >
              <Icon name={draftSignal.icon ?? "info"} />
            </span>
          ) : null}
        </div>
        <span className="tw:min-w-1 tw:flex-1" />
        <WorkbenchSelect
          label={t("sql.databaseSelector")}
          title={t("sql.databaseSelectorHint", {
            connection: connection.name || t("app.unnamed"),
            database: effectiveDatabase,
          })}
          icon="database"
          value={effectiveDatabase}
          disabled={running || databaseOptions.length < 2}
          onChange={setSelectedDatabase}
        >
          {databaseOptions.map((database) => (
            <option key={database} value={database}>
              {database}
            </option>
          ))}
        </WorkbenchSelect>
        <WorkbenchSelect
          label={t("sql.schemaSelector")}
          title={t("sql.schemaSelectorHint", {
            connection: connection.name || t("app.unnamed"),
            schema: effectiveNamespace,
          })}
          icon="database"
          value={effectiveNamespace}
          disabled={running || namespaceOptions.length === 0}
          onChange={setSelectedSchema}
        >
          {namespaceOptions.map((namespace) => (
            <option key={namespace} value={namespace}>
              {namespace}
            </option>
          ))}
        </WorkbenchSelect>
        {documentSaveState !== "saved" ? (
          <span
            data-state={documentSaveState}
            className="tw:grid tw:size-control-sm tw:shrink-0 tw:place-items-center tw:text-muted-foreground tw:data-[state=conflict]:text-danger tw:data-[state=error]:text-danger tw:data-[state=saving]:text-primary"
            title={
              documentSaveError ??
              (documentSaveState === "saving"
                ? t("common.saving")
                : documentSaveState === "conflict"
                  ? t("sql.saveConflict")
                  : documentSaveState === "error"
                    ? t("sql.saveFailed")
                    : recovered
                      ? t("sql.recovered")
                      : t("sql.unsaved"))
            }
            role="status"
          >
            <Icon
              name={
                documentSaveState === "saving"
                  ? "refresh"
                  : documentSaveState === "conflict" ||
                      documentSaveState === "error"
                    ? "alert"
                    : "info"
              }
            />
          </span>
        ) : null}
      </WorkbenchToolbar>
      <WorkbenchContainedBody>
        <div
          data-workbench-scroll-owner="sql-editor"
          className="tw:min-h-0 tw:flex-1 tw:overflow-hidden tw:bg-background tw:[&>.cm-theme-dark]:h-full tw:[&_.cm-editor]:h-full tw:[&_.cm-editor]:bg-background tw:[&_.cm-scroller]:min-h-0 tw:[&_.cm-scroller]:overflow-auto tw:[&_.cm-scroller]:overscroll-contain"
        >
          <LazySqlViewer
            value={draft}
            editable
            onChange={setDraft}
            onRun={executeSqlFromEditor}
            catalog={catalog}
            engine={connection.engine}
            resolveMode={resolveMode}
            defaultSchema={effectiveNamespace}
            namespaceOptions={namespaceOptions}
            minHeight="0px"
            onCursorChange={handleCursorChange}
            onBlur={flushEditorState}
            executionStatus={editorExecutionStatus}
          />
        </div>

        <div
          data-workbench-scroll-owner="document-details"
          className="scrollbar-sleek tw:max-h-[50%] tw:min-h-0 tw:shrink-0 tw:overflow-auto tw:overscroll-contain tw:bg-background"
        >
          {documentConflict && (
            <div
              className="tw:mx-3 tw:flex tw:min-h-control-lg tw:items-center tw:justify-between tw:gap-3 tw:border-y tw:border-warning tw:py-2 tw:text-sm tw:text-warning tw:max-[760px]:flex-col tw:max-[760px]:items-start"
              role="alert"
            >
              <span>{t("sql.saveConflictBody")}</span>
              <div className="ds-control-row">
                <WorkbenchButton
                  variant="default"
                  onClick={loadSavedConflictVersion}
                >
                  {t("sql.loadSaved")}
                </WorkbenchButton>
                <WorkbenchButton
                  variant="default"
                  onClick={keepLocalConflictVersion}
                >
                  {t("sql.keepMine")}
                </WorkbenchButton>
              </div>
            </div>
          )}
          {documentSaveError && documentSaveState === "error" && (
            <div className="tw:mx-3 tw:mt-2 tw:text-ui tw:text-danger">
              {t("sql.saveFailed")}: {documentSaveError}
            </div>
          )}
          {planErr && (
            <div className="tw:mx-3 tw:mt-2 tw:text-ui tw:text-danger">
              {planErr}
            </div>
          )}
          {plan && (
            <details
              open
              className="tw:my-2 tw:border-y tw:border-border-subtle tw:bg-background"
            >
              <summary className="tw:flex tw:min-h-workbench-toolbar tw:cursor-pointer tw:items-center tw:gap-2 tw:px-3 tw:py-1 tw:font-semibold">
                {t("sql.queryPlan")}
                <span className="tw:ml-auto">
                  <WorkbenchButton
                    iconOnly
                    size="xs"
                    onClick={(event) => {
                      event.preventDefault();
                      setPlan(null);
                    }}
                    title={t("common.close")}
                    aria-label={t("common.close")}
                  >
                    <Icon name="close" />
                  </WorkbenchButton>
                </span>
              </summary>
              {plan.plan ? (
                <pre className="tw:m-0 tw:overflow-x-auto tw:border-t tw:border-border-subtle tw:bg-background tw:p-3 tw:font-mono tw:text-sm tw:whitespace-pre">
                  {plan.plan}
                </pre>
              ) : (
                <div className="tw:border-t tw:border-border-subtle tw:px-3 tw:py-2 tw:text-muted-foreground">
                  {t("sql.noPlan", { mode: plan.mode })}
                </div>
              )}
            </details>
          )}

          {pendingApproval && (
            <ApprovalCard
              key={pendingApproval.proposal.operationId}
              connectionId={connection.id}
              engine={connection.engine}
              sql={pendingApproval.sql}
              safety={safety}
              initialProposal={pendingApproval.proposal}
              onExecuted={(outcome) => {
                setResultKind("single");
                setRun({
                  sql: pendingApproval.sql,
                  outcome,
                  at: new Date().toLocaleTimeString(),
                });
                setPendingApproval(null);
              }}
              onReject={() => {
                setApprovalRejected(true);
                setPendingApproval(null);
              }}
            />
          )}

          {pendingScriptApproval && (
            <section className="tw:my-2 tw:grid tw:gap-3 tw:border-y tw:border-warning tw:bg-background tw:p-3">
              <div className="ds-title-line">
                <strong>{t("approval.review")}</strong>
                <StatusBadge tone="warning">
                  {t("sql.statementCount", {
                    count: pendingScriptApproval.proposal.statementCount,
                  })}
                </StatusBadge>
              </div>
              <LazySqlViewer
                value={pendingScriptApproval.sql}
                minHeight="96px"
              />
              <div className="tw:text-sm tw:text-muted-foreground tw:[&_code]:font-mono tw:[&_code]:text-xs tw:[&_code]:[overflow-wrap:anywhere]">
                {t("approval.payloadHash")}{" "}
                <code>{pendingScriptApproval.proposal.payloadHash}</code>
              </div>
              {pendingScriptApproval.proposal.confirmationPhrase && (
                <label className="tw:grid tw:gap-2 tw:text-sm tw:[&_input]:w-[min(100%,320px)] tw:[&_input]:font-mono">
                  <span>
                    {t("approval.confirmationPrompt")}{" "}
                    <code>
                      {pendingScriptApproval.proposal.confirmationPhrase}
                    </code>
                  </span>
                  <input
                    value={scriptConfirmation}
                    onChange={(event) =>
                      setScriptConfirmation(event.target.value)
                    }
                    placeholder={
                      pendingScriptApproval.proposal.confirmationPhrase
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              )}
              <div className="ds-action-row ds-control-row">
                <WorkbenchButton
                  variant="primary"
                  disabled={
                    running ||
                    (!!pendingScriptApproval.proposal.confirmationPhrase &&
                      scriptConfirmation !==
                        pendingScriptApproval.proposal.confirmationPhrase)
                  }
                  onClick={() => void approvePendingScript()}
                >
                  {t("approval.approveAndRunWrite")}
                </WorkbenchButton>
                <WorkbenchButton
                  variant="default"
                  disabled={running}
                  onClick={() => void rejectPendingScript()}
                >
                  {t("approval.reject")}
                </WorkbenchButton>
              </div>
            </section>
          )}
        </div>
      </WorkbenchContainedBody>
      {parameterDialog ? (
        <SqlParameterDialog
          parameters={parameterDialog.parameters}
          initialValues={parameterValues}
          action={parameterDialog.action}
          onCancel={() => setParameterDialog(null)}
          onApply={applyParameterValues}
        />
      ) : null}
    </WorkbenchPane>
  );
}
