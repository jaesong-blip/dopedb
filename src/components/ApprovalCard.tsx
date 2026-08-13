// L4 — the human approval gate, as UX. Given a connection + a SQL string, this card
// runs L1 classify + L3 preview, renders the full risk picture, and gates execution:
//   - read-only SELECTs may auto-run when the connection's autoRunReads is on;
//   - writes / DDL / privilege are ALWAYS hard-gated behind an explicit Approve,
//     and Approve is disabled unless the connection allows writes.
// Nothing here is trusted for safety — the Rust core re-enforces every gate (L2).

import { useEffect, useRef, useState } from "react";
import {
  approveOperation,
  rejectOperation,
} from "../features/operations/tauriAdapter";
import type {
  Engine,
  ExecOutcome,
  SafetySettings,
} from "../ipc/types";
import { errMessage, isQueryCancellationError } from "../ipc/types";
import {
  cancelQuery,
  proposeSql,
  runSql,
} from "../features/queries/tauriAdapter";
import type {
  Classification,
  PreviewReport,
  RiskLevel,
  SqlOperationProposal,
} from "../features/queries/domain";
import { Icon, type IconName } from "./Icon";
import LazySqlViewer from "./LazySqlViewer";
import { useI18n, type I18nKey } from "../lib/i18n";
import {
  StatusBadge,
  type StatusTone,
} from "../design-system/components/Status";
import { Button } from "../design-system/components/Button";
import { TextInput } from "../design-system/components/FormControls";

const ENGINE_LABEL: Record<Engine, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  mongodb: "MongoDB",
};

const RISK_LABEL: Record<RiskLevel, I18nKey> = {
  low: "approval.riskLow",
  medium: "approval.riskMedium",
  high: "approval.riskHigh",
};

const RISK_TONE: Record<RiskLevel, StatusTone> = {
  low: "success",
  medium: "warning",
  high: "danger",
};

function StatusGlyph({
  label,
  icon = "info",
  tone,
}: {
  label: string;
  icon?: IconName;
  tone?: "ok" | "warning" | "danger";
}) {
  return (
    <span
      data-tone={tone ?? "neutral"}
      className="badge icon-only-badge tw:data-[tone=ok]:border-success tw:data-[tone=ok]:text-success tw:data-[tone=danger]:border-danger tw:data-[tone=danger]:text-danger"
      title={label}
      aria-label={label}
      role="img"
    >
      <Icon name={icon} />
    </span>
  );
}

export default function ApprovalCard({
  connectionId,
  engine,
  sql,
  safety,
  initialProposal,
  rationale,
  collapseSql = false,
  onExecuted,
  onReject,
}: {
  connectionId: string;
  engine: Engine;
  sql: string;
  safety: SafetySettings;
  initialProposal?: SqlOperationProposal;
  rationale?: string;
  collapseSql?: boolean;
  onExecuted: (outcome: ExecOutcome) => void;
  onReject?: () => void;
}) {
  const { t } = useI18n();
  const [cls, setCls] = useState<Classification | null>(null);
  const [preview, setPreview] = useState<PreviewReport | null>(null);
  const [proposal, setProposal] = useState<SqlOperationProposal | null>(null);
  const [proposalVersion, setProposalVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState<null | "approved" | "rejected">(null);
  const [cancelled, setCancelled] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  // The in-flight query id, so Cancel can signal it. Held in a ref (not state) since
  // execute() reads it synchronously and it never needs to re-render. `cancelledRef`
  // mirrors the flag so execute()'s catch sees it without a stale closure.
  const queryId = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  // Elapsed seconds while a query runs, so a slow query reads differently from a hung one.
  const [elapsed, setElapsed] = useState(0);

  // L1 + L3 whenever the statement changes.
  useEffect(() => {
    let alive = true;
    setCls(null);
    setPreview(null);
    setProposal(null);
    setError(null);
    setDecided(null);
    setCancelled(false);
    setConfirmation("");
    if (!sql.trim()) return;
    (async () => {
      try {
        const p =
          initialProposal && proposalVersion === 0
            ? initialProposal
            : await proposeSql(connectionId, sql);
        if (!alive) return;
        setProposal(p);
        setCls(p.classification);
        setPreview(p.preview);
      } catch (e) {
        if (alive) setError(errMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [connectionId, initialProposal, proposalVersion, sql]);

  const isRead = cls?.kind === "read";
  const isWrite = !!cls && !isRead;
  const writesBlocked = isWrite && !safety.allowWrites;
  const confirmationPhrase = proposal?.confirmationPhrase ?? null;
  const confirmationMatches =
    confirmationPhrase === null || confirmation === confirmationPhrase;
  // Reads auto-run only when the connection allows it. Target mutations always
  // stay behind an exact Operation approval regardless of legacy saved settings.
  const canAutoRun = isRead && proposal?.autoRun === true;

  async function execute() {
    if (!proposal) return;
    const id = proposal.operationId;
    queryId.current = id;
    cancelledRef.current = false;
    setBusy(true);
    setError(null);
    setCancelled(false);
    try {
      if (proposal.approvalRequired) {
        await approveOperation(
          proposal.operationId,
          proposal.payloadHash,
          confirmationPhrase ? confirmation : undefined,
        );
      }
      const outcome = await runSql(proposal.operationId);
      setDecided("approved");
      onExecuted(outcome);
    } catch (e) {
      // A local cancel click is benign only when Rust confirms a read cancellation.
      // An interrupted write is `outcomeUnknown` and must stay visible.
      if (cancelledRef.current && isQueryCancellationError(e)) setCancelled(true);
      else setError(errMessage(e));
    } finally {
      queryId.current = null;
      setBusy(false);
    }
  }

  async function reject() {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (proposal.approvalRequired) {
        await rejectOperation(proposal.operationId, proposal.payloadHash);
      }
      setDecided("rejected");
      onReject?.();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    if (queryId.current) {
      cancelledRef.current = true;
      void cancelQuery(queryId.current);
    }
  }

  // Tick the elapsed counter while busy; reset+clear when done or unmounted.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // Auto-run reads (per settings) exactly once, after classification lands.
  useEffect(() => {
    if (canAutoRun && decided === null && !busy) {
      void execute();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoRun]);

  const previewN =
    preview?.exactRows ?? preview?.estimatedRows ?? null;
  const compact = collapseSql;
  const sqlBlock = <LazySqlViewer value={sql} minHeight={collapseSql ? "56px" : "80px"} />;
  const approvalHead = (
    <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
      {cls ? (
        <>
          <span className="badge kind">{cls.kind.toUpperCase()}</span>
          <StatusBadge tone={RISK_TONE[cls.risk]}>
            {t(RISK_LABEL[cls.risk])}
          </StatusBadge>
          <span className="badge">{ENGINE_LABEL[engine]}</span>
          {cls.noWhere && (
            <span className="badge nowhere">{t("approval.noWhere")}</span>
          )}
          {cls.statementCount > 1 && (
            <span className="badge nowhere">
              {t("sql.statementCount", { count: cls.statementCount })}
            </span>
          )}
        </>
      ) : (
        <StatusGlyph label={t("approval.checkingSafety")} icon="refresh" />
      )}
    </div>
  );
  const tablesBlock = cls && cls.tables.length > 0 && (
    <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:text-sm">
      <span className="tw:text-xs tw:tracking-[0.04em] tw:text-muted-foreground tw:uppercase">
        {t("approval.targetTables")}
      </span>
      {cls.tables.map((tbl) => (
        <code
          key={tbl}
          className="tw:rounded-sm tw:bg-muted tw:px-2 tw:py-0.5 tw:font-mono tw:text-sm"
        >
          {tbl}
        </code>
      ))}
    </div>
  );
  const previewBlock = (
    <div className="tw:text-sm tw:leading-relaxed">
      <span className="tw:text-xs tw:tracking-[0.04em] tw:text-muted-foreground tw:uppercase">
        {t("approval.impactPreview")}
      </span>
      {!preview ? (
        <StatusGlyph label={t("approval.estimatingImpact")} icon="refresh" />
      ) : isWrite && !writesBlocked && previewN === null ? (
        // A runnable write with NO row estimate (skipped over threshold, or an EXPLAIN
        // that yielded no count) means approving a destructive statement blind — surface
        // it. Not for writes-disabled (can't run) or reads (a null estimate is benign).
        <span className="tw:font-medium tw:text-warning">
          {" "}
          <Icon name="alert" /> {t("approval.impactUnknown")}
          {preview.note && (
            <em className="tw:text-muted-foreground"> — {preview.note}</em>
          )}
        </span>
      ) : (
        <span>
          {" "}
          {preview.mode === "explain" && t("approval.modeExplain")}
          {preview.mode === "execRollback" && t("approval.modeExecRollback")}
          {preview.mode === "skipped" && t("approval.modeSkipped")}
          {previewN !== null && (
            <>
              {" — "}
              <strong>{previewN.toLocaleString()}</strong> {t("approval.rows")}
            </>
          )}
          {preview.note && (
            <em className="tw:text-muted-foreground"> — {preview.note}</em>
          )}
        </span>
      )}
    </div>
  );
  const planBlock = preview?.plan && (
    <details>
      <summary className="tw:cursor-pointer tw:py-1 tw:text-ui tw:text-muted-foreground">
        {t("sql.queryPlan")}
      </summary>
      <pre className="tw:max-h-[216px] tw:overflow-auto tw:rounded-sm tw:border tw:border-border-subtle tw:bg-muted tw:p-2 tw:font-mono tw:text-sm">
        {preview.plan}
      </pre>
    </details>
  );
  const notesBlock = cls?.notes.map((n, i) => (
    <div key={i} className="tw:text-sm tw:text-muted-foreground">
      - {n}
    </div>
  ));
  const payloadHashBlock = proposal && (
    <div className="tw:text-sm tw:text-muted-foreground">
      {t("approval.payloadHash")}{" "}
      <code className="tw:font-mono tw:text-xs tw:break-all">
        {proposal.payloadHash}
      </code>
    </div>
  );
  const confirmationBlock = confirmationPhrase && (
    <label className="tw:grid tw:gap-2 tw:text-sm">
      <span>
        {t("approval.confirmationPrompt")}{" "}
        <code className="tw:font-mono">{confirmationPhrase}</code>
      </span>
      <span className="tw:w-full tw:max-w-[320px]">
        <TextInput
          monospace
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={confirmationPhrase}
          autoComplete="off"
          spellCheck={false}
        />
      </span>
    </label>
  );
  const compactStatus = writesBlocked
    ? t("approval.writesDisabledCompact")
    : !cls
      ? t("approval.checkingSafety")
      : !preview
        ? t("approval.checkingImpact")
        : previewN !== null
          ? t(
              previewN === 1 ? "approval.rowsInScope" : "approval.rowsInScopePlural",
              { count: previewN.toLocaleString() },
            )
          : t("approval.readyToReview");

  return (
    <div data-approval-review className="card tw:grid tw:gap-3">
      {!compact && approvalHead}

      {rationale && (
        <div>
          <div className="tw:text-xs tw:tracking-[0.04em] tw:text-muted-foreground tw:uppercase">
            {compact ? t("approval.change") : t("approval.review")}
          </div>
          <p className="tw:mt-1 tw:mb-0 tw:leading-relaxed">{rationale}</p>
        </div>
      )}

      {compact && (
        <div
          data-tone={
            writesBlocked ? "danger" : previewN !== null ? "ok" : "neutral"
          }
          className="badge icon-only-badge tw:data-[tone=ok]:border-success tw:data-[tone=ok]:text-success tw:data-[tone=danger]:border-danger tw:data-[tone=danger]:text-danger"
          title={compactStatus}
          aria-label={compactStatus}
          role="img"
        >
          <Icon
            name={
              writesBlocked
                ? "circleSlash"
                : !cls || !preview
                  ? "refresh"
                  : previewN !== null
                    ? "check"
                    : "info"
            }
          />
        </div>
      )}

      {!compact && sqlBlock}
      {!compact && tablesBlock}
      {!compact && previewBlock}
      {!compact && planBlock}
      {!compact && notesBlock}
      {!compact && payloadHashBlock}
      {confirmationBlock}

      {error && <div className="tw:text-ui tw:text-danger">{error}</div>}
      {/* Additive, not a terminal branch — the action buttons below stay reachable so a
          cancelled query can simply be run again. */}
      {cancelled && <StatusGlyph label={t("sql.cancelled")} icon="circleSlash" />}

      {decided === "approved" ? (
        <StatusGlyph label={t("approval.executed")} icon="check" tone="ok" />
      ) : decided === "rejected" ? (
        // Not a dead-end: keep the statement visible above and let the user undo the
        // rejection to approve it, rather than forcing a re-issue.
        <div className="ds-action-row ds-control-row">
          <StatusGlyph label={t("approval.rejected")} icon="circleSlash" tone="danger" />
          <Button
            onClick={() => {
              setDecided(null);
              setProposalVersion((version) => version + 1);
            }}
          >
            {t("approval.reconsider")}
          </Button>
        </div>
      ) : busy ? (
        <div className="ds-action-row ds-control-row">
          <StatusGlyph
            label={`${canAutoRun ? t("approval.readOnlyRunning") : t("approval.running")} ${elapsed}s`}
            icon="refresh"
          />
          <Button onClick={cancel}>
            {t("common.cancel")}
          </Button>
        </div>
      ) : canAutoRun && !cancelled ? (
        <StatusGlyph label={t("approval.readOnlyAutoRunning")} icon="play" />
      ) : (
        <div className="ds-action-row ds-control-row">
          {writesBlocked && !compact && (
            <div className="tw:text-ui tw:text-danger">
              {t("approval.writesDisabledBody")}
            </div>
          )}
          <Button
            variant="primary"
            disabled={busy || !proposal || writesBlocked || !confirmationMatches}
            onClick={() => void execute()}
          >
            {isWrite
              ? compact
                ? t("approval.applyChange")
                : t("approval.approveAndRunWrite")
              : t("sql.run")}
          </Button>
          <Button
            disabled={busy || !proposal}
            onClick={() => void reject()}
          >
            {t("approval.reject")}
          </Button>
        </div>
      )}
      {compact && (
        <div className="tw:grid tw:gap-2 tw:[&_details]:overflow-hidden tw:[&_details]:rounded-sm tw:[&_details]:border tw:[&_details]:border-border-subtle tw:[&_details]:bg-muted tw:[&_summary]:cursor-pointer tw:[&_summary]:px-3 tw:[&_summary]:py-2 tw:[&_summary]:text-ui tw:[&_summary]:text-muted-foreground">
          <details>
            <summary>{t("approval.safetyDetails")}</summary>
            <div className="tw:grid tw:gap-2 tw:px-3 tw:pb-3">
              {approvalHead}
              {tablesBlock}
              {previewBlock}
              {planBlock}
              {notesBlock}
              {payloadHashBlock}
            </div>
          </details>
          <details className="tw:[&_.cm-editor]:border-t tw:[&_.cm-editor]:border-border-subtle">
            <summary>{t("approval.generatedSql")}</summary>
            {sqlBlock}
          </details>
        </div>
      )}
    </div>
  );
}
