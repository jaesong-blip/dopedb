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
  classifySql,
  previewSql,
  proposeSql,
  runSql,
} from "../../features/queries/tauriAdapter";
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
import { stamp } from "../../lib/export";
import { useI18n } from "../../lib/i18n";
import { catalogQuery } from "../../lib/queries";
import { splitStatements } from "../../lib/sqlStatements";
import { useQueryRun } from "../../lib/useQueryRun";
import "./sql.css";

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
  const [limit, setLimit] = useState(STEP);
  const [scriptOut, setScriptOut] = useState<{ outcome: ScriptOutcome; at: string } | null>(null);
  const { running, cancelled, execute, cancel, track } = useQueryRun();
  const [runErr, setRunErr] = useState<QueryErrorInfo | null>(null);
  const [lastAttempt, setLastAttempt] = useState<LastAttempt | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingSqlApproval | null>(null);
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
          const proposal = await proposeSql(connection.id, sql, "manual");
          if (proposal.approvalRequired) {
            setPendingApproval({ proposal, sql, at });
            return;
          }
          track(proposal.operationId);
          const outcome = await runSql(proposal.operationId);
          setRun({ sql, outcome, at });
        }
      });
    } catch (e) {
      const details = errDetails(e);
      setRunErr({ ...details, sql, at: new Date().toLocaleTimeString() });
      // Clear the attempted kind so a failed run can't leave the previous
      // result sitting under the error card looking current.
      if (script) setScriptOut(null);
      else setRun(null);
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
          pending.proposal.confirmationPhrase
            ? scriptConfirmation
            : undefined,
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
      // Keep the casual Explain action read-only. Write previews are also EXPLAIN-only,
      // but their risk review belongs to the exact proposal flow below.
      const cls = await classifySql(connection.id, draft);
      if (cls.kind !== "read") {
        setPlan(null);
        setPlanErr(t("sql.explainReadOnly"));
        return;
      }
      setPlan(await previewSql(connection.id, draft));
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
  const { data: catalog } = useQuery(catalogQuery(connection.id));
  const promptSql = lastAttempt?.sql || draft;
  const aiPrompt = useMemo(
    () => buildSqlHelpPrompt({ connection, sql: promptSql, error: runErr }),
    [connection, promptSql, runErr],
  );

  return (
    <div className="screen sqlconsole">
      <div className="sql-agent-launchers">
        <div className="sql-document-identity">
          <input
            className="sql-document-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label={t("sql.documentTitle")}
            spellCheck={false}
          />
          <span
            className={`sql-save-state state-${documentSaveState}`}
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
        <button
          className="btn small ghost sql-agent-btn"
          onClick={onOpenAgent}
          title={t("sql.openAgentTerminal")}
        >
          <Icon name="terminal" />
          {t("sql.openAgentTerminal")}
        </button>
      </div>
      <div className="editor-box">
        <LazySqlViewer
          value={draft}
          editable
          onChange={setDraft}
          onRun={executeSql}
          catalog={catalog}
          minHeight="clamp(96px, 18vh, 140px)"
        />
      </div>
      <div className="form-actions sql-actions ds-control-row">
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
          <span className="badge script-count">
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
            <button className="btn small" onClick={cancel}>
              {t("sql.cancel")}
            </button>
          </>
        ) : (
          draftSignal && (
            <span
              className={
                "badge icon-only-badge" +
                (draftSignal.tone === "danger"
                  ? " status-error"
                  : draftSignal.tone === "warning"
                    ? " risk-medium"
                    : "")
              }
              title={draftSignal.title ?? draftSignal.text}
              aria-label={draftSignal.text}
              role="img"
            >
              <Icon name={draftSignal.icon ?? "info"} />
            </span>
          )
        )}
      </div>

      {documentConflict && (
        <div className="sql-document-conflict" role="alert">
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
        <div className="error sql-save-error">
          {t("sql.saveFailed")}: {documentSaveError}
        </div>
      )}
      {planErr && <div className="error">{planErr}</div>}
      {plan && (
        <details open className="card explain-plan">
          <summary>
            {t("sql.queryPlan")}
            <button className="btn small icon-only icon-xs plan-close" onClick={() => setPlan(null)} title={t("common.close")} aria-label={t("common.close")}>
              <Icon name="close" />
            </button>
          </summary>
          {plan.plan ? (
            <pre>{plan.plan}</pre>
          ) : (
            <div className="muted">{t("sql.noPlan", { mode: plan.mode })}</div>
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
        <section className="card script-approval">
          <div className="ds-title-line">
            <strong>{t("approval.review")}</strong>
            <span className="badge risk-medium">
              {t("sql.statementCount", {
                count: pendingScriptApproval.proposal.statementCount,
              })}
            </span>
          </div>
          <LazySqlViewer
            value={pendingScriptApproval.sql}
            minHeight="96px"
          />
          <div className="muted script-approval-hash">
            {t("approval.payloadHash")}{" "}
            <code>{pendingScriptApproval.proposal.payloadHash}</code>
          </div>
          {pendingScriptApproval.proposal.confirmationPhrase && (
            <label className="script-approval-confirmation">
              <span>
                {t("approval.confirmationPrompt")}{" "}
                <code>{pendingScriptApproval.proposal.confirmationPhrase}</code>
              </span>
              <input
                value={scriptConfirmation}
                onChange={(event) => setScriptConfirmation(event.target.value)}
                placeholder={pendingScriptApproval.proposal.confirmationPhrase}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          <div className="ds-action-row ds-control-row">
            <button
              className="btn primary"
              disabled={
                running
                || (
                  !!pendingScriptApproval.proposal.confirmationPhrase
                  && scriptConfirmation !== pendingScriptApproval.proposal.confirmationPhrase
                )
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

      {runErr && (
        <SqlErrorCard error={runErr} prompt={aiPrompt} />
      )}
      {cancelled && <div className="muted sql-run-message">{t("sql.cancelled")}</div>}

      <div className={running && (run || scriptOut) ? "sql-results busy" : "sql-results"}>
        {!running && !run && !scriptOut && !plan && !planErr && !runErr && (
          <div className="sql-empty">
            <Icon name="table" />
            <span>{t("sql.resultsEmpty")}</span>
          </div>
        )}
        {resultKind === "single" && run && (
          <Outcome
            run={run}
            limit={limit}
            maxRows={safety.maxRows}
            onMore={() => setLimit((l) => l + STEP)}
          />
        )}
        {resultKind === "script" && scriptOut && (
          <ScriptResults outcome={scriptOut.outcome} at={scriptOut.at} />
        )}
      </div>
    </div>
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
    <div className="sql-error-card" role="alert">
      <div className="sql-error-head">
        <div>
          <strong>{t("sql.errorTitle")}</strong>
          <span className="muted"> · {error.at}</span>
        </div>
      </div>
      <div className="sql-error-grid">
        <span className="muted">{t("sql.errorKind")}</span>
        <code>{error.kind ?? t("common.unknown")}</code>
        <span className="muted">{t("sql.errorMessage")}</span>
        <pre>{error.message}</pre>
        {pos && (
          <>
            <span className="muted">{t("sql.errorPosition")}</span>
            <pre>
              {t("sql.errorPositionAt", { line: pos.line, column: pos.column })}
              {"\n"}
              {pos.snippet}
            </pre>
          </>
        )}
      </div>
      <details className="sql-error-context">
        <summary>{t("sql.errorContext")}</summary>
        <pre>{prompt}</pre>
      </details>
    </div>
  );
}

function ScriptResults({ outcome, at }: { outcome: ScriptOutcome; at: string }) {
  const { t } = useI18n();
  const summary = outcome.allReads
    ? t("sql.readOnlyScript")
    : outcome.committed
      ? t("sql.committed")
      : t("sql.failedRolledBack");
  return (
    <div className="results script-results">
      <div className="result-meta muted">
        {summary} · {t("sql.statementCount", { count: outcome.statements.length })} · {at}
      </div>
      {outcome.statements.map((s, i) => (
        <div key={i} className="stmt-result">
          <div className="result-meta muted">
            <span className="stmt-num">{i + 1}</span>
            <code className="result-sql">{s.sql}</code>
          </div>
          {s.error ? (
            <div className="error">{s.error}</div>
          ) : s.result ? (
            <>
              <div className="muted stmt-rowmeta">
                {t(s.result.truncated ? "agent.rowsTruncated" : "agent.rows", {
                  count: s.result.rowCount,
                })} ·{" "}
                {s.result.durationMs} ms
                {" · "}
                <ResultToolbar
                  columns={s.result.columns}
                  rows={s.result.rows}
                  filenameBase={`script-stmt${i + 1}-${stamp()}`}
                />
              </div>
              <DataGrid result={s.result} />
            </>
          ) : (
            <div className="muted">{t("sql.affected", { count: s.affected ?? 0 })}</div>
          )}
        </div>
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
    <div className="results">
      <div className="result-meta muted">
        <code className="result-sql">{sql}</code>
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
            {outcome.committed ? t("sql.writeCommitted") : t("sql.noRowsReturned")}
            {outcome.affected !== null && <> · {t("sql.affected", { count: outcome.affected })}</>} · {at}
          </>
        )}
      </div>
      {r && (
        <>
          <DataGrid result={limit < r.rows.length ? { ...r, rows: r.rows.slice(0, limit) } : r} />
          {r.rows.length > limit && (
            <button className="btn" onClick={onMore}>
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
