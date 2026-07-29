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
  runSqlReadStream,
  runSqlStream,
} from "../../features/queries/tauriAdapter";
import {
  effectiveSqlNamespace,
  sqlNamespaceOptions,
} from "../../features/queries/namespace";
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
import { buildRunSignal } from "../../features/query/runSignal";
import {
  findSqlParameters,
  materializeSqlParameters,
  type SqlParameter,
} from "../../features/query/sqlParameters";
import ApprovalCard from "../../components/ApprovalCard";
import { Icon } from "../../components/Icon";
import LazySqlViewer from "../../components/LazySqlViewer";
import {
  WorkbenchDivider,
  WorkbenchPane,
  WorkbenchToolbar,
} from "../../design-system/components/Workbench";
import { useI18n } from "../../lib/i18n";
import { catalogQuery, useCatalogScope } from "../../lib/queries";
import { splitStatements } from "../../lib/sqlStatements";
import { useQueryRun } from "../../lib/useQueryRun";
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
  parameters: SqlParameter[];
  action: "apply" | "explain" | "run";
}

function buildSqlHelpPrompt({
  connection,
  namespace,
  sql,
  error,
}: {
  connection: ConnectionProfile;
  namespace: string;
  sql: string;
  error: QueryErrorInfo | null;
}) {
  const lines = [
    "DopeDB SQL context",
    "",
    `Connection: ${connection.name || "(unnamed)"}`,
    `Engine: ${connection.engine}`,
    `Database: ${connection.database}`,
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
  draft,
  setDraft,
  title,
  setTitle,
  selectedSchema,
  setSelectedSchema,
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
  setDraft: (s: string) => void;
  title: string;
  setTitle: (title: string) => void;
  selectedSchema: string | null;
  setSelectedSchema: (selectedSchema: string | null) => void;
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
  const draftStatements = useMemo(() => splitStatements(draft), [draft]);
  const draftIsScript = draftStatements.length > 1;
  const draftSignal = useMemo(
    () => buildRunSignal(draft, draftStatements, safety, t),
    [draft, draftStatements, safety, t],
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
  const draftParameters = useMemo(
    () => findSqlParameters(draft, connection.engine),
    [connection.engine, draft],
  );
  const catalogScope = useCatalogScope();
  const { data: catalog } = useQuery(catalogQuery(connection.id, catalogScope));
  const namespaceOptions = useMemo(
    () => sqlNamespaceOptions(connection, catalog),
    [catalog, connection],
  );
  const effectiveNamespace = useMemo(
    () =>
      effectiveSqlNamespace(connection, selectedSchema, namespaceOptions),
    [connection, namespaceOptions, selectedSchema],
  );

  useEffect(() => {
    if (!effectiveNamespace || selectedSchema === effectiveNamespace) return;
    setSelectedSchema(effectiveNamespace);
  }, [effectiveNamespace, selectedSchema, setSelectedSchema]);

  const {
    saveState: documentSaveState,
    saveError: documentSaveError,
    conflict: documentConflict,
    useSavedVersion: loadSavedConflictVersion,
    keepLocalVersion: keepLocalConflictVersion,
    reportError: reportDocumentSaveError,
  } = useSqlDocumentAutosave({
    gateway: tauriSqlDocumentGateway,
    connectionId: connectionId(connection.id),
    documentId: persistedId ? sqlDocumentId(persistedId) : null,
    revision,
    title,
    selectedSchema,
    content: draft,
    recovered,
    onTitleChange: setTitle,
    onSelectedSchemaChange: setSelectedSchema,
    onContentChange: setDraft,
    onPersisted,
  });

  async function formatDraft() {
    if (!draft.trim() || formatting) return;
    setFormatting(true);
    try {
      const formatter = await import("sql-formatter");
      const language: SqlLanguage =
        connection.engine === "postgres"
          ? "postgresql"
          : connection.engine === "mysql"
            ? "mysql"
            : "sqlite";
      setDraft(
        formatter.format(draft, {
          language,
          keywordCase: "upper",
          tabWidth: 2,
          linesBetweenQueries: 2,
        }),
      );
    } catch (error) {
      reportDocumentSaveError(error);
    } finally {
      setFormatting(false);
    }
  }

  async function runSql(sql: string) {
    if (!sql || running || !safetyReady) return;
    globalThis.performance?.clearMarks?.(
      "desktop_query_interaction_start",
    );
    globalThis.performance?.mark?.("desktop_query_interaction_start");

    const statements = splitStatements(sql);
    const script = statements.length > 1;
    const at = new Date().toLocaleTimeString();
    const sessionId = nextQueryServiceSessionId(documentId);
    serviceSessionRef.current = {
      id: sessionId,
      documentId,
      connectionId: connection.id,
      connectionName: connection.name,
      consoleTitle: title,
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
    setPendingApproval(null);
    setPendingScriptApproval(null);
    setRun(null);
    setScriptOut(null);
    setResultKind(script ? "script" : "single");
    setLastAttempt({ sql, at });

    try {
      await execute(async () => {
        await resetDesktopStream();
        if (script) {
          const proposal = await proposeScript(
            connection.id,
            sql,
            "manual",
            effectiveNamespace,
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
            );
            if (proposalSqlRunPath(proposal) === "approval") {
              setPendingApproval({ proposal, sql, at });
              return;
            }
            setRun(null);
            await startDesktopStream((onBatch) =>
              runSqlStream(proposal.operationId, onBatch),
            );
          };
          if (initialSqlRunPath(safety.autoRunReads) === "combinedReadStream") {
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

  function executeSql(selectedSql?: string) {
    const sql = selectedSql?.trim() || draft.trim();
    if (!sql || running || !safetyReady) return;
    const parameters = findSqlParameters(sql, connection.engine);
    if (parameters.length > 0) {
      setParameterDialog({ sql, parameters, action: "run" });
      return;
    }
    void runSql(sql);
  }

  function openParameterDialog() {
    if (draftParameters.length === 0) return;
    setParameterDialog({
      sql: draft,
      parameters: draftParameters,
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
    if (pending.action === "run") void runSql(sql);
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
    if (!draft.trim() || draftIsScript || explaining) return;
    if (draftParameters.length > 0) {
      setParameterDialog({
        sql: draft,
        parameters: draftParameters,
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
  }, [draft]);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const promptSql = lastAttempt?.sql || draft;
  const aiPrompt = useMemo(
    () =>
      buildSqlHelpPrompt({
        connection,
        namespace: effectiveNamespace,
        sql: promptSql,
        error: runErr,
      }),
    [connection, effectiveNamespace, promptSql, runErr],
  );

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
    } else if (resultKind === "single" && stream.phase !== "idle") {
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
        : cancelled || stream.phase === "cancelled"
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
          <button
            className="btn primary small icon-only"
            disabled={!draft.trim() || running || !safetyReady}
            onClick={() => void executeSql()}
            title={t("sql.runHint")}
            aria-label={running ? t("sql.running") : t("sql.run")}
          >
            <Icon name={running ? "refresh" : "play"} />
          </button>
          <button
            className="btn small ghost icon-only"
            onClick={onOpenHistory}
            title={t("sql.history")}
            aria-label={t("sql.history")}
          >
            <Icon name="history" />
          </button>
          <button
            className="btn small ghost icon-only"
            disabled={draftParameters.length === 0 || running}
            onClick={openParameterDialog}
            title={
              draftParameters.length > 0
                ? t("sql.viewParametersCount", {
                    count: draftParameters.length,
                  })
                : t("sql.noParameters")
            }
            aria-label={t("sql.viewParameters")}
          >
            <Icon name="parameter" />
          </button>
          <button
            className="btn small ghost icon-only"
            disabled={
              !draft.trim() ||
              draftIsScript ||
              explaining ||
              running ||
              !safetyReady
            }
            title={draftIsScript ? t("sql.explainSingle") : t("sql.explainTitle")}
            aria-label={t("sql.explain")}
            onClick={explain}
          >
            <Icon name={explaining ? "refresh" : "target"} />
          </button>
          <button
            className="btn small ghost icon-only"
            disabled={!draft.trim() || formatting || running}
            onClick={() => void formatDraft()}
            title={t("sql.formatTitle")}
            aria-label={t("sql.format")}
          >
            <Icon name={formatting ? "refresh" : "list"} />
          </button>
          {running ? (
            <>
              <span
                className="badge icon-only-badge"
                title={t("sql.runningFor", { seconds: elapsed })}
                aria-label={t("sql.runningFor", { seconds: elapsed })}
                role="img"
              >
                <Icon name="refresh" />
              </span>
              <button
                className="btn small icon-only"
                onClick={() => {
                  cancel();
                  void cancelDesktopStream();
                }}
                title={t("sql.cancel")}
                aria-label={t("sql.cancel")}
              >
                <Icon name="close" />
              </button>
            </>
          ) : null}
          <WorkbenchDivider />
          {!safetyReady ? (
            <button
              type="button"
              className="badge tw:cursor-pointer tw:border-warning tw:bg-transparent tw:text-warning"
              onClick={onRetrySafety}
              title={
                safetyLoadError ??
                t("sql.safetyLoading")
              }
            >
              <Icon name={safetyLoadError ? "alert" : "refresh"} />
              {safetyLoadError
                ? t("sql.retrySafety")
                : t("sql.safetyLoading")}
            </button>
          ) : (
            <>
              <span
                className="tw:inline-flex tw:h-control-sm tw:shrink-0 tw:items-center tw:gap-1 tw:px-1 tw:text-sm tw:text-muted-foreground"
                title={t("sql.txAutoHint")}
              >
                <span>{t("sql.tx")}</span>
                <strong className="tw:font-medium tw:text-foreground">
                  {t("sql.txAuto")}
                </strong>
              </span>
              <span
                className="tw:inline-flex tw:h-control-sm tw:shrink-0 tw:items-center tw:px-1 tw:text-sm tw:text-muted-foreground"
                title={
                  safety.autoRunReads
                    ? t("sql.readAutoHint")
                    : t("sql.readReviewHint")
                }
              >
                {safety.autoRunReads
                  ? t("sql.readAuto")
                  : t("sql.readReview")}
              </span>
            </>
          )}
          {draftIsScript ? (
            <span className="badge tw:text-muted-foreground">
              {t("sql.statementCount", {
                count: draftStatements.length,
              })}
            </span>
          ) : null}
          {!running && draftSignal ? (
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
        <label
          className="tw:inline-flex tw:h-control-sm tw:min-w-0 tw:max-w-[180px] tw:shrink tw:items-center tw:gap-1 tw:rounded-xs tw:px-1 tw:text-sm tw:text-foreground tw:hover:bg-muted"
          title={t("sql.schemaSelectorHint", {
            connection: connection.name || t("app.unnamed"),
            schema: effectiveNamespace,
          })}
        >
          <Icon
            name="database"
            className="tw:shrink-0 tw:text-muted-foreground"
          />
          <span className="tw:sr-only">{t("sql.schemaSelector")}</span>
          <select
            className="tw:h-control-sm tw:min-w-0 tw:max-w-[140px] tw:cursor-pointer tw:truncate tw:border-0 tw:bg-transparent tw:p-0 tw:pr-1 tw:font-sans tw:text-sm tw:text-foreground tw:shadow-none tw:outline-none tw:focus:border-transparent tw:focus:shadow-none tw:disabled:cursor-default tw:disabled:opacity-50"
            value={effectiveNamespace}
            disabled={running || namespaceOptions.length === 0}
            onChange={(event) => setSelectedSchema(event.target.value)}
            aria-label={t("sql.schemaSelector")}
          >
            {namespaceOptions.map((namespace) => (
              <option key={namespace} value={namespace}>
                {namespace}
              </option>
            ))}
          </select>
        </label>
        <span
          data-state={documentSaveState}
          className="tw:grid tw:size-control-sm tw:shrink-0 tw:place-items-center tw:text-muted-foreground tw:data-[state=conflict]:text-danger tw:data-[state=error]:text-danger tw:data-[state=saving]:text-primary"
          title={
            documentSaveError ??
            (documentSaveState === "saving"
              ? t("common.saving")
              : documentSaveState === "saved"
                ? t("sql.saved")
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
                  : "check"
            }
          />
        </span>
      </WorkbenchToolbar>
      <div className="tw:min-h-[180px] tw:flex-1 tw:overflow-hidden tw:bg-background tw:[&_.cm-editor]:h-full tw:[&_.cm-editor]:bg-background tw:[&_.cm-scroller]:min-h-0">
        <LazySqlViewer
          value={draft}
          editable
          onChange={setDraft}
          onRun={executeSql}
          catalog={catalog}
          minHeight="180px"
        />
      </div>

      <div className="tw:max-h-[50%] tw:shrink-0 tw:overflow-auto tw:bg-background">
        {documentConflict && (
          <div
            className="tw:mx-3 tw:flex tw:min-h-control-lg tw:items-center tw:justify-between tw:gap-3 tw:border-y tw:border-warning tw:py-2 tw:text-sm tw:text-warning tw:max-[760px]:flex-col tw:max-[760px]:items-start"
            role="alert"
          >
            <span>{t("sql.saveConflictBody")}</span>
            <div className="ds-control-row">
              <button className="btn small" onClick={loadSavedConflictVersion}>
                {t("sql.loadSaved")}
              </button>
              <button className="btn small" onClick={keepLocalConflictVersion}>
                {t("sql.keepMine")}
              </button>
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
            className="tw:mx-3 tw:my-3 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3"
          >
            <summary className="tw:flex tw:cursor-pointer tw:items-center tw:gap-2 tw:font-semibold">
              {t("sql.queryPlan")}
              <button
                className="btn small icon-only icon-xs tw:ml-auto"
                onClick={() => setPlan(null)}
                title={t("common.close")}
                aria-label={t("common.close")}
              >
                <Icon name="close" />
              </button>
            </summary>
            {plan.plan ? (
              <pre className="tw:mt-2 tw:mb-0 tw:overflow-x-auto tw:rounded-sm tw:border tw:border-border-subtle tw:bg-background tw:p-2 tw:text-sm tw:whitespace-pre">
                {plan.plan}
              </pre>
            ) : (
              <div className="tw:text-muted-foreground">
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
            onReject={() => setPendingApproval(null)}
          />
        )}

        {pendingScriptApproval && (
          <section className="tw:mx-3 tw:my-3 tw:grid tw:gap-3 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <div className="ds-title-line">
              <strong>{t("approval.review")}</strong>
              <span className="badge risk-medium">
                {t("sql.statementCount", {
                  count: pendingScriptApproval.proposal.statementCount,
                })}
              </span>
            </div>
            <LazySqlViewer value={pendingScriptApproval.sql} minHeight="96px" />
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
              <button
                className="btn primary"
                disabled={
                  running ||
                  (!!pendingScriptApproval.proposal.confirmationPhrase &&
                    scriptConfirmation !==
                      pendingScriptApproval.proposal.confirmationPhrase)
                }
                onClick={() => void approvePendingScript()}
              >
                {t("approval.approveAndRunWrite")}
              </button>
              <button
                className="btn"
                disabled={running}
                onClick={() => void rejectPendingScript()}
              >
                {t("approval.reject")}
              </button>
            </div>
          </section>
        )}

      </div>
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
