// Manual SQL console. Editable CodeMirror. Run is the human approval action for
// manual SQL, so execution stays in-place: action bar status first, results below.
// Multi-statement scripts execute through the backend script runner and return
// per-statement results. ⌘↩ runs the current draft or selected SQL.
import { useEffect, useMemo, useState } from "react";
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
import { useSqlResultStream } from "../../features/queries/useSqlResultStream";
import type {
  PreviewReport,
  SqlOperationProposal,
} from "../../features/queries/domain";
import {
  connectionId,
  sqlDocumentId,
  type SqlDocument,
} from "../../features/sqlDocuments/domain";
import { tauriSqlDocumentGateway } from "../../features/sqlDocuments/tauriAdapter";
import { useSqlDocumentAutosave } from "../../features/sqlDocuments/useSqlDocumentAutosave";
import { buildRunSignal } from "../../features/query/runSignal";
import ApprovalCard from "../../components/ApprovalCard";
import DataGrid from "../../components/DataGrid";
import { Icon } from "../../components/Icon";
import LazySqlViewer from "../../components/LazySqlViewer";
import ResultToolbar from "../../components/ResultToolbar";
import {
  ResultMeta,
  SqlSnippet,
  WorkbenchDivider,
  WorkbenchEmptyState,
  WorkbenchPane,
  WorkbenchToolbar,
} from "../../design-system/components/Workbench";
import { stamp } from "../../lib/export";
import { useI18n } from "../../lib/i18n";
import { catalogQuery, useCatalogScope } from "../../lib/queries";
import { splitStatements } from "../../lib/sqlStatements";
import { useQueryRun } from "../../lib/useQueryRun";
import {
  canFallbackFromCombinedRead,
  initialSqlRunPath,
  proposalSqlRunPath,
} from "./runPath";
import StreamOutcome from "./StreamOutcome";

const STEP = 200;

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

function buildSqlHelpPrompt({
  connection,
  sql,
  error,
}: {
  connection: ConnectionProfile;
  sql: string;
  error: QueryErrorInfo | null;
}) {
  const lines = [
    "DopeDB SQL context",
    "",
    `Connection: ${connection.name || "(unnamed)"}`,
    `Engine: ${connection.engine}`,
    `Database: ${connection.database}`,
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
  safety,
  draft,
  setDraft,
  title,
  setTitle,
  persistedId,
  revision,
  recovered,
  onPersisted,
  onOpenAgent,
}: {
  connection: ConnectionProfile;
  safety: SafetySettings;
  draft: string;
  setDraft: (s: string) => void;
  title: string;
  setTitle: (title: string) => void;
  persistedId: string | null;
  revision: number;
  recovered: boolean;
  onPersisted: (document: SqlDocument) => void;
  onOpenAgent: () => void;
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
  const [limit, setLimit] = useState(STEP);
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

  // EXPLAIN plan (read-only preview) shown above the results, independent of execution.
  const [plan, setPlan] = useState<PreviewReport | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [formatting, setFormatting] = useState(false);

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
    content: draft,
    recovered,
    onTitleChange: setTitle,
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

  async function executeSql(selectedSql?: string) {
    const sql = selectedSql?.trim() || draft.trim();
    if (!sql || running) return;
    globalThis.performance?.clearMarks?.(
      "desktop_query_interaction_start",
    );
    globalThis.performance?.mark?.("desktop_query_interaction_start");

    const statements = splitStatements(sql);
    const script = statements.length > 1;
    const at = new Date().toLocaleTimeString();
    setRunErr(null);
    setPendingApproval(null);
    setPendingScriptApproval(null);
    setLimit(STEP);
    setResultKind(script ? "script" : "single");
    setLastAttempt({ sql, at });

    try {
      await execute(async () => {
        await resetDesktopStream();
        if (script) {
          const proposal = await proposeScript(connection.id, sql, "manual");
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
            const proposal = await proposeSql(connection.id, sql, "manual");
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
                runSqlReadStream(connection.id, sql, onBatch, "manual"),
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

  async function explain() {
    if (!draft.trim() || draftIsScript || explaining) return;
    setPlanErr(null);
    setExplaining(true);
    try {
      // One backend inspection owns classification, authority pinning, and the
      // read-only Explain. There is no classify-to-preview IPC race to bridge.
      const inspection = await inspectSql(connection.id, draft);
      setPlan(inspection.report);
    } catch (e) {
      setPlanErr(errMessage(e));
      setPlan(null);
    } finally {
      setExplaining(false);
    }
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

  // #8: feed schema-aware autocomplete. Same introspected Catalog the sidebar tree and the
  // Schema view read, served from the shared query cache. Failure just leaves completion off.
  const catalogScope = useCatalogScope();
  const { data: catalog } = useQuery(catalogQuery(connection.id, catalogScope));
  const promptSql = lastAttempt?.sql || draft;
  const aiPrompt = useMemo(
    () => buildSqlHelpPrompt({ connection, sql: promptSql, error: runErr }),
    [connection, promptSql, runErr],
  );

  return (
    <WorkbenchPane>
      <WorkbenchToolbar label={t("sql.documentTitle")} compact>
        <div className="tw:flex tw:min-w-0 tw:flex-[0_1_auto] tw:items-center tw:gap-1 tw:max-[760px]:shrink-0">
          <input
            className="tw:h-control-sm tw:w-[clamp(120px,18vw,240px)] tw:border-transparent tw:bg-transparent tw:font-semibold tw:focus:border-border-strong tw:focus:bg-background tw:max-[760px]:w-[140px]"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label={t("sql.documentTitle")}
            spellCheck={false}
          />
          <span
            data-state={documentSaveState}
            className="tw:shrink-0 tw:text-xs tw:text-muted-foreground tw:data-[state=conflict]:text-danger tw:data-[state=error]:text-danger tw:data-[state=saving]:text-primary"
            title={documentSaveError ?? undefined}
          >
            {documentSaveState === "saving"
              ? t("common.saving")
              : documentSaveState === "saved"
                ? t("sql.saved")
                : documentSaveState === "conflict"
                  ? t("sql.saveConflict")
                  : documentSaveState === "error"
                    ? t("sql.saveFailed")
                    : recovered
                      ? t("sql.recovered")
                      : t("sql.unsaved")}
          </span>
        </div>
        <WorkbenchDivider />
        <div className="ds-control-row scrollbar-sleek tw:flex tw:min-h-0 tw:min-w-0 tw:flex-[0_1_auto] tw:flex-nowrap tw:items-center tw:gap-1 tw:overflow-x-auto tw:overflow-y-hidden tw:max-[760px]:shrink-0">
          <button
            className="btn primary small"
            disabled={!draft.trim() || running}
            onClick={() => void executeSql()}
            title={t("sql.runHint")}
          >
            <Icon name="play" />
            {running ? t("sql.running") : t("sql.run")}
          </button>
          <button
            className="btn small ghost"
            disabled={!draft.trim() || draftIsScript || explaining || running}
            title={draftIsScript ? t("sql.explainSingle") : t("sql.explainTitle")}
            onClick={explain}
          >
            {explaining ? t("sql.planning") : t("sql.explain")}
          </button>
          <button
            className="btn small ghost"
            disabled={!draft.trim() || formatting || running}
            onClick={() => void formatDraft()}
            title={t("sql.formatTitle")}
          >
            {formatting ? t("sql.formatting") : t("sql.format")}
          </button>
          {draftIsScript && (
            <span className="badge tw:text-muted-foreground">
              {t("sql.statementCount", { count: draftStatements.length })}
            </span>
          )}
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
                className="btn small"
                onClick={() => {
                  cancel();
                  void cancelDesktopStream();
                }}
              >
                {t("sql.cancel")}
              </button>
            </>
          ) : (
            draftSignal && (
              <span
                data-tone={draftSignal.tone}
                className="badge icon-only-badge tw:data-[tone=danger]:border-danger tw:data-[tone=danger]:text-danger tw:data-[tone=warning]:border-warning tw:data-[tone=warning]:text-warning"
                title={draftSignal.title ?? draftSignal.text}
                aria-label={draftSignal.text}
                role="img"
              >
                <Icon name={draftSignal.icon ?? "info"} />
              </span>
            )
          )}
        </div>
        <span className="tw:min-w-2 tw:flex-1 tw:max-[760px]:hidden" />
        <button
          className="btn small ghost tw:min-w-[56px] tw:shrink-0 tw:px-2 tw:text-xs tw:@max-[760px]:size-control-sm tw:@max-[760px]:min-w-control-sm tw:@max-[760px]:px-0"
          onClick={onOpenAgent}
          title={t("sql.openAgentTerminal")}
        >
          <Icon name="terminal" />
          <span className="tw:@max-[760px]:hidden">
            {t("sql.openAgentTerminal")}
          </span>
        </button>
      </WorkbenchToolbar>
      <div className="tw:h-[clamp(180px,34vh,340px)] tw:min-h-[180px] tw:flex-[0_1_auto] tw:overflow-hidden tw:border-b tw:border-border-subtle tw:bg-background tw:[&_.cm-editor]:h-full tw:[&_.cm-editor]:bg-background tw:[&_.cm-scroller]:min-h-0">
        <LazySqlViewer
          value={draft}
          editable
          onChange={setDraft}
          onRun={executeSql}
          catalog={catalog}
          minHeight="180px"
        />
      </div>

      <div className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:overflow-auto tw:bg-background">
        <div
          className="tw:flex tw:h-control-sm tw:shrink-0 tw:items-end tw:border-b tw:border-border-subtle tw:bg-card tw:px-2"
          role="tablist"
          aria-label={t("sql.resultsTab")}
        >
          <button
            type="button"
            role="tab"
            aria-selected="true"
            className="tw:relative tw:h-control-sm tw:border-0 tw:bg-transparent tw:px-3 tw:font-sans tw:text-sm tw:text-foreground tw:after:absolute tw:after:right-2 tw:after:bottom-0 tw:after:left-2 tw:after:h-0.5 tw:after:bg-primary"
          >
            {t("sql.resultsTab")}
          </button>
        </div>
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

        {runErr && <SqlErrorCard error={runErr} prompt={aiPrompt} />}
        {cancelled && (
          <div className="tw:mx-3 tw:mt-2 tw:text-sm tw:text-muted-foreground">
            {t("sql.cancelled")}
          </div>
        )}

        <div
          data-busy={
            running &&
            Boolean(
              run ||
                scriptOut ||
                stream.phase === "connecting" ||
                stream.phase === "streaming",
            )
          }
          className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:data-[busy=true]:pointer-events-none tw:data-[busy=true]:opacity-50"
        >
        {!running &&
          !run &&
          !scriptOut &&
          stream.phase === "idle" &&
          !plan &&
          !planErr &&
          !runErr && (
            <WorkbenchEmptyState icon="table">
              {t("sql.resultsEmpty")}
            </WorkbenchEmptyState>
          )}
        {resultKind === "single" && run && (
          <Outcome
            run={run}
            limit={limit}
            maxRows={safety.maxRows}
            onMore={() => setLimit((l) => l + STEP)}
          />
        )}
        {resultKind === "single" && stream.phase !== "idle" && (
          <StreamOutcome
            stream={stream}
            sql={lastAttempt?.sql ?? draft}
            maxRows={safety.maxRows}
          />
        )}
        {resultKind === "script" && scriptOut && (
          <ScriptResults outcome={scriptOut.outcome} at={scriptOut.at} />
        )}
        </div>
      </div>
    </WorkbenchPane>
  );
}

// Postgres reports a 1-based character offset into the executed SQL. Map it to the
// offending line and render that line with a caret under the exact column. PG counts
// code points while JS strings index UTF-16 code units, so work on a code-point array
// (keeps the caret honest when astral chars, e.g. emoji in literals, precede the error).
function errorPosition(sql: string, position: number) {
  const cps = Array.from(sql);
  const i = Math.min(Math.max(position - 1, 0), cps.length);
  const lineStart = i === 0 ? 0 : cps.lastIndexOf("\n", i - 1) + 1;
  const lineEnd = cps.indexOf("\n", i);
  const column = i - lineStart;
  return {
    line: cps.slice(0, i).filter((c) => c === "\n").length + 1,
    column: column + 1,
    snippet:
      cps.slice(lineStart, lineEnd === -1 ? cps.length : lineEnd).join("") +
      "\n" +
      " ".repeat(column) +
      "^",
  };
}

function SqlErrorCard({
  error,
  prompt,
}: {
  error: QueryErrorInfo;
  prompt: string;
}) {
  const { t } = useI18n();
  const pos =
    error.position !== null ? errorPosition(error.sql, error.position) : null;
  return (
    <div
      className="tw:mx-3 tw:my-3 tw:grid tw:gap-3 tw:rounded-md tw:border tw:border-danger-border tw:bg-danger-muted tw:p-3 tw:text-foreground"
      role="alert"
    >
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:max-[760px]:flex-col tw:max-[760px]:items-start">
        <div>
          <strong className="tw:text-danger">{t("sql.errorTitle")}</strong>
          <span className="tw:text-muted-foreground"> · {error.at}</span>
        </div>
      </div>
      <div className="tw:grid tw:grid-cols-[max-content_minmax(0,1fr)] tw:items-start tw:gap-x-3 tw:gap-y-2 tw:[&_code]:rounded-sm tw:[&_code]:border tw:[&_code]:border-border-subtle tw:[&_code]:bg-card tw:[&_code]:p-2 tw:[&_pre]:m-0 tw:[&_pre]:overflow-auto tw:[&_pre]:rounded-sm tw:[&_pre]:border tw:[&_pre]:border-border-subtle tw:[&_pre]:bg-card tw:[&_pre]:p-2 tw:[&_pre]:text-sm tw:[&_pre]:whitespace-pre-wrap tw:[&_pre]:[overflow-wrap:anywhere] tw:max-[760px]:grid-cols-1">
        <span className="tw:text-muted-foreground">{t("sql.errorKind")}</span>
        <code>{error.kind ?? t("common.unknown")}</code>
        <span className="tw:text-muted-foreground">
          {t("sql.errorMessage")}
        </span>
        <pre>{error.message}</pre>
        {pos && (
          <>
            <span className="tw:text-muted-foreground">
              {t("sql.errorPosition")}
            </span>
            <pre>
              {t("sql.errorPositionAt", { line: pos.line, column: pos.column })}
              {"\n"}
              {pos.snippet}
            </pre>
          </>
        )}
      </div>
      <details>
        <summary className="tw:cursor-pointer tw:text-ui tw:text-muted-foreground">
          {t("sql.errorContext")}
        </summary>
        <pre className="tw:mt-2 tw:max-h-[280px] tw:overflow-auto tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:p-2 tw:text-sm tw:whitespace-pre-wrap tw:[overflow-wrap:anywhere]">
          {prompt}
        </pre>
      </details>
    </div>
  );
}

function ScriptResults({
  outcome,
  at,
}: {
  outcome: ScriptOutcome;
  at: string;
}) {
  const { t } = useI18n();
  const summary = outcome.allReads
    ? t("sql.readOnlyScript")
    : outcome.committed
      ? t("sql.committed")
      : t("sql.failedRolledBack");
  return (
    <div className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col">
      <ResultMeta>
        {summary} ·{" "}
        {t("sql.statementCount", { count: outcome.statements.length })} · {at}
      </ResultMeta>
      {outcome.statements.map((s, i) => (
        <section
          key={i}
          className="tw:border-t tw:border-border-subtle tw:pt-2"
        >
          <ResultMeta>
            <span className="tw:inline-block tw:min-w-4 tw:font-semibold">
              {i + 1}
            </span>
            <SqlSnippet>{s.sql}</SqlSnippet>
          </ResultMeta>
          {s.error ? (
            <div className="tw:px-3 tw:py-2 tw:text-ui tw:text-danger">
              {s.error}
            </div>
          ) : s.result ? (
            <>
              <div className="tw:mx-3 tw:my-1 tw:text-sm tw:text-muted-foreground">
                {t(s.result.truncated ? "agent.rowsTruncated" : "agent.rows", {
                  count: s.result.rowCount,
                })}{" "}
                · {s.result.durationMs} ms
                {" · "}
                <ResultToolbar
                  columns={s.result.columns}
                  rows={s.result.rows}
                  filenameBase={`script-stmt${i + 1}-${stamp()}`}
                />
              </div>
              <DataGrid result={s.result} surface="workbench" />
            </>
          ) : (
            <div className="tw:px-3 tw:py-2 tw:text-sm tw:text-muted-foreground">
              {t("sql.affected", { count: s.affected ?? 0 })}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function Outcome({
  run,
  limit,
  maxRows,
  onMore,
}: {
  run: Run;
  limit: number;
  maxRows: number;
  onMore: () => void;
}) {
  const { t } = useI18n();
  const { outcome, sql, at } = run;
  const r = outcome.result;

  return (
    <div className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col">
      <ResultMeta>
        <SqlSnippet>{sql}</SqlSnippet>
        {r ? (
          <>
            {" · "}
            {t(r.truncated ? "agent.rowsTruncated" : "agent.rows", {
              count: r.rowCount,
            })}
            {r.truncated && ` - ${t("sql.capped", { count: maxRows })}`} ·{" "}
            {r.durationMs} ms · {at}
            {" · "}
            <ResultToolbar
              columns={r.columns}
              rows={r.rows}
              filenameBase={`query-${stamp()}`}
            />
          </>
        ) : (
          <>
            {" · "}
            {outcome.committed
              ? t("sql.writeCommitted")
              : t("sql.noRowsReturned")}
            {outcome.affected !== null && (
              <> · {t("sql.affected", { count: outcome.affected })}</>
            )}{" "}
            · {at}
          </>
        )}
      </ResultMeta>
      {r && (
        <>
          <DataGrid
            result={
              limit < r.rows.length ? { ...r, rows: r.rows.slice(0, limit) } : r
            }
            surface="workbench"
          />
          {r.rows.length > limit && (
            <button className="btn tw:m-3 tw:self-start" onClick={onMore}>
              {t("sql.showMore", {
                count: Math.min(STEP, r.rows.length - limit),
                total: r.rows.length,
              })}
            </button>
          )}
        </>
      )}
    </div>
  );
}
