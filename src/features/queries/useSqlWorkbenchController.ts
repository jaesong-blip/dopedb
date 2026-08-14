// Owns SQL editor persistence, target resolution, execution approval, streaming,
// cancellation, and Services projection for the manual query workbench.
import { useEffect, useMemo, useRef, useState } from "react";
import type { SqlLanguage } from "sql-formatter";
import { useQuery } from "@tanstack/react-query";

import type { ConnectionProfile } from "../connections/domain";
import {
  approveOperation,
  rejectOperation,
} from "../operations/tauriAdapter";
import {
  localizeRunSignal,
} from "../query/runSignal";
import { useSqlDraftAnalysis } from "../query/useSqlDraftAnalysis";
import { formatSqlDocument } from "../query/sqlFormatter";
import { useSqlEditorBuffer } from "../query/useSqlEditorBuffer";
import {
  findSqlParameters,
  materializeSqlParameters,
  type SqlParameter,
} from "../query/sqlParameters";
import {
  nextQueryServiceSessionId,
  type QueryServiceResult,
  type QueryServiceSession,
} from "../queryServices/domain";
import {
  connectionId,
  sqlDocumentId,
  type SqlDocument,
} from "../sqlDocuments/domain";
import { tauriSqlDocumentGateway } from "../sqlDocuments/tauriAdapter";
import { useSqlDocumentAutosave } from "../sqlDocuments/useSqlDocumentAutosave";
import {
  publishWorkbenchDraft,
  useWorkbenchDraft,
} from "../workbench/draftStore";
import type {
  AppErrorDetails,
  ExecOutcome,
  SafetySettings,
  ScriptOperationProposal,
  ScriptOutcome,
} from "../../ipc/types";
import { errDetails, errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import { useEventCallback } from "../../lib/useEventCallback";
import {
  connectionDatabasesQuery,
  databaseCatalogQuery,
  useCatalogScope,
} from "../../lib/queries";
import { splitStatements } from "../../lib/sqlStatements";
import { useQueryRun } from "../../lib/useQueryRun";
import type { PreviewReport, SqlOperationProposal } from "./domain";
import type {
  SqlCursorPosition,
  SqlExecutionStatus,
  SqlRunSource,
} from "./editorStatus";
import {
  clearSqlEditorCursor,
  publishSqlEditorCursor,
} from "./editorStatusStore";
import {
  effectiveSqlNamespace,
  sqlNamespaceOptions,
} from "./namespace";
import type { SqlResolveMode } from "./resolveMode";
import {
  canFallbackFromCombinedRead,
  initialSqlRunPath,
  proposalSqlRunPath,
} from "./runPath";
import {
  scriptProductAnalyticsSummary,
  streamProductAnalyticsOutcome,
  useQueryExecutionAnalytics,
} from "./productAnalytics";
import {
  inspectSql,
  proposeScript,
  proposeSql,
  runScript,
  runSql as runSqlOperation,
  runSqlReadStream,
  runSqlStream,
} from "./tauriAdapter";
import { useManualTransaction } from "./useManualTransaction";
import { useSqlResultStream } from "./useSqlResultStream";

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

export type SqlWorkbenchProps = {
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
};

export function useSqlWorkbenchController({
  connection,
  documentId,
  safety,
  safetyReady,
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
}: SqlWorkbenchProps) {
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
  const scriptAnalytics = scriptOut
    ? scriptProductAnalyticsSummary(scriptOut.outcome)
    : null;
  const queryAnalytics = useQueryExecutionAnalytics({
    scope: catalogScope,
    approvalPending: Boolean(pendingApproval || pendingScriptApproval),
    approvalRejected,
    cancelled,
    failed: runErr !== null,
    materializedCompleted: run !== null,
    materializedRowCount: run?.outcome.result?.rowCount ?? null,
    materializedDurationMs: run?.outcome.result?.durationMs ?? null,
    scriptOutcome: scriptAnalytics?.outcome ?? null,
    scriptRowCount: scriptAnalytics?.rowCount ?? null,
    streamRunId: stream.runId,
    streamOutcome: streamProductAnalyticsOutcome(stream.phase),
    streamRowCount: stream.rowCount,
    streamDurationMs: stream.durationMs,
  });
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
    const analyticsAttempt = queryAnalytics.begin(sql, stream.runId);
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
        queryAnalytics.arm(analyticsAttempt);
        if (script) {
          const proposal = await proposeScript(
            connection.id,
            sql,
            "manual",
            effectiveNamespace,
            effectiveDatabase,
          );
          if (proposal.approvalRequired) {
            queryAnalytics.requireApproval(analyticsAttempt);
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
              queryAnalytics.requireApproval(analyticsAttempt);
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
            initialSqlRunPath(safety.autoRunReads, sql) ===
              "combinedReadStream"
          ) {
            queryAnalytics.disarm(analyticsAttempt);
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
              if (!canFallbackFromCombinedRead(errDetails(error).kind)) {
                queryAnalytics.arm(analyticsAttempt);
                throw error;
              }
              await resetDesktopStream();
              queryAnalytics.arm(analyticsAttempt);
              await runPlannedSql();
            }
            queryAnalytics.arm(analyticsAttempt);
          } else {
            // Manual/read-only settings still stream after the durable proposal;
            // approved write/DDL returns its bounded materialized outcome.
            await runPlannedSql();
          }
        }
      });
    } catch (e) {
      queryAnalytics.arm(analyticsAttempt);
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
    lastAttempt,
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

  const cancelRun = () => {
    cancel();
    void cancelDesktopStream();
  };
  const closeParameterDialog = () => setParameterDialog(null);
  const closePlan = () => setPlan(null);
  const completePendingApproval = (outcome: ExecOutcome) => {
    if (!pendingApproval) return;
    setResultKind("single");
    setRun({
      sql: pendingApproval.sql,
      outcome,
      at: new Date().toLocaleTimeString(),
    });
    setPendingApproval(null);
  };
  const rejectPendingApproval = () => {
    setApprovalRejected(true);
    setPendingApproval(null);
  };

  return {
    analysisCurrent,
    applyParameterValues,
    approvePendingScript,
    cancelRun,
    catalog,
    closeParameterDialog,
    closePlan,
    completePendingApproval,
    databaseOptions,
    documentConflict,
    documentSaveError,
    documentSaveState,
    draft,
    draftIsScript,
    draftParameterCount,
    draftSignal,
    editorExecutionStatus,
    effectiveDatabase,
    effectiveNamespace,
    elapsed,
    executeSql,
    executeSqlFromEditor,
    explain,
    explaining,
    flushEditorState,
    formatDraft,
    formatting,
    handleCursorChange,
    keepLocalConflictVersion,
    loadSavedConflictVersion,
    manualTransaction,
    namespaceOptions,
    openParameterDialog,
    parameterDialog,
    parameterValues,
    pendingApproval,
    pendingScriptApproval,
    plan,
    planErr,
    rejectPendingApproval,
    rejectPendingScript,
    resolveModeHint,
    running,
    scriptConfirmation,
    setDraft,
    setScriptConfirmation,
  };
}
