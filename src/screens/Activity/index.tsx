// Unified activity view. Query history stays optimized for replay, while the
// append-only audit log remains available as lazy-loaded security detail.
import { useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errMessage } from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import { Icon, type IconName } from "../../components/Icon";
import Skeleton from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { WorkbenchPane } from "../../design-system/components/Workbench";
import { auditSnapshotQuery, auditVerdictQuery, historyQuery, qk } from "../../lib/queries";
import { fullTime, relTime } from "../../lib/relTime";
import { useI18n } from "../../lib/i18n";

const CAP = 200;

function duration(ms: number | null): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function firstLine(sql: string): string {
  const line = sql.trim().split("\n")[0];
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function statusIcon(status: string): IconName {
  if (status === "ok" || status === "success" || status === "done") return "check";
  if (status === "error" || status === "blocked" || status === "failed") return "alert";
  return "info";
}

function short(hash: string | null): string {
  if (!hash) return "∅";
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

function actionTone(action: string) {
  const value = action.toLowerCase();
  if (value.includes("approve")) return "success";
  if (value.includes("execute")) return "primary";
  if (value.includes("reject") || value.includes("blocked")) return "danger";
  return "neutral";
}

function originTone(origin: string) {
  if (origin === "agent") return "primary";
  if (origin === "migration") return "warning";
  return "neutral";
}

function statusTone(status: string) {
  if (status === "ok" || status === "success" || status === "done") {
    return "success";
  }
  if (status === "error" || status === "blocked" || status === "failed") {
    return "danger";
  }
  return "neutral";
}

export default function Activity({
  connection,
  onLoadSql,
  initialAuditOpen = false,
  onInitialAuditOpenConsumed,
}: {
  connection: ConnectionProfile;
  onLoadSql: (sql: string) => void;
  initialAuditOpen?: boolean;
  onInitialAuditOpenConsumed?: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [text, setText] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [originFilter, setOriginFilter] = useState("");
  const [auditOpen, setAuditOpen] = useState(initialAuditOpen);
  // Audit rows can be numerous, so verification runs immediately while the full list stays
  // unfetched until the disclosure is opened. After that it refreshes with everything else.
  const [auditWanted, setAuditWanted] = useState(initialAuditOpen);

  useEffect(() => {
    if (initialAuditOpen) onInitialAuditOpenConsumed?.();
    // Initial navigation intent is consumed once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The query history paints as soon as it settles; a large hash-chain verification runs
  // beside it and never holds up the replay surface.
  const history = useQuery(historyQuery(connection.id));
  const verdictResult = useQuery(auditVerdictQuery(connection.id));
  const snapshot = useQuery(auditSnapshotQuery(connection.id, auditWanted));

  // Invalidation (not refetch) so the audit list is skipped while its disclosure is closed.
  function refresh() {
    void queryClient.invalidateQueries({ queryKey: qk.history(connection.id) });
    void queryClient.invalidateQueries({ queryKey: qk.audit(connection.id) });
  }

  function handleAuditToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    const open = event.currentTarget.open;
    setAuditOpen(open);
    if (open) setAuditWanted(true);
  }

  const rows = history.data ?? [];
  const historyError = history.error ? errMessage(history.error) : null;
  const historyLoading = history.isPending;
  // A failed refresh keeps the last-good rows: a transient error must not blank a
  // verified trail. React Query retains `data` across a failed refetch for exactly this.
  const auditSnapshot = snapshot.data ?? null;
  const auditDetailsError = snapshot.error ? errMessage(snapshot.error) : null;
  const auditDetailsLoading = snapshot.isFetching;
  const integrityError = auditDetailsError ?? (verdictResult.error ? errMessage(verdictResult.error) : null);

  const statuses = useMemo(
    () => [...new Set(rows.map((row) => row.status))].sort(),
    [rows],
  );
  const origins = useMemo(
    () => [...new Set(rows.map((row) => row.origin))].sort(),
    [rows],
  );

  const filtered = rows.filter(
    (row) =>
      (!text || row.sql.toLowerCase().includes(text.toLowerCase())) &&
      (!statusFilter || row.status === statusFilter) &&
      (!originFilter || row.origin === originFilter),
  );
  const shown = filtered.slice(0, CAP);

  function load(sql: string) {
    onLoadSql(sql);
    toast(t("activity.loaded"));
  }

  const auditEntries = auditSnapshot?.entries ?? null;
  const detailVerdict = auditSnapshot?.verdict ?? null;
  // The snapshot verdict describes exactly the rows on screen, so it wins over the
  // standalone verification whenever the list has been loaded.
  const verdict = detailVerdict ?? verdictResult.data ?? null;
  // firstBadIndex is oldest-first; the displayed entries are newest-first.
  const tamperedId =
    detailVerdict && !detailVerdict.ok && detailVerdict.firstBadIndex != null && auditEntries
      ? auditEntries[auditEntries.length - 1 - detailVerdict.firstBadIndex]?.id ?? null
      : null;
  const tamperedEntry = tamperedId
    ? auditEntries?.find((entry) => entry.id === tamperedId) ?? null
    : null;

  const chainBroken = verdict !== null && !verdict.ok;
  const tamperedTs = chainBroken ? tamperedEntry?.ts ?? null : null;
  const integrityTitle = integrityError
    ? t("activity.auditUnavailable")
    : verdict === null
      ? t("activity.auditVerifying")
      : chainBroken
        ? tamperedTs
          ? t("activity.auditChainBrokenAt", { time: relTime(tamperedTs) })
          : t("activity.auditChainBroken")
        : t("activity.auditVerified");
  const integrityDanger = !!integrityError || chainBroken;
  const integrityIcon: IconName = integrityError || chainBroken ? "alert" : verdict ? "check" : "info";
  const busy = history.isFetching || verdictResult.isFetching || snapshot.isFetching;

  return (
    <WorkbenchPane>
      <div className="tw:mx-auto tw:flex tw:min-h-0 tw:w-full tw:max-w-[1120px] tw:flex-1 tw:flex-col tw:overflow-auto">
        <details
          data-danger={integrityDanger}
          className="tw:group tw:shrink-0 tw:border-b tw:border-border-subtle tw:bg-background tw:data-[danger=true]:border-danger tw:data-[danger=true]:bg-danger-muted"
          open={auditOpen}
          onToggle={handleAuditToggle}
        >
          <summary
            id="activity-audit-summary"
            className="tw:grid tw:min-h-workbench-toolbar tw:cursor-pointer tw:list-none tw:grid-cols-[var(--ds-icon-md)_minmax(0,1fr)_auto] tw:items-center tw:gap-2 tw:px-3 tw:py-1 tw:focus-visible:outline-2 tw:focus-visible:-outline-offset-2 tw:focus-visible:outline-ring tw:[&::-webkit-details-marker]:hidden tw:max-[760px]:grid-cols-[var(--ds-icon-md)_minmax(0,1fr)]"
          >
            <Icon
              name={integrityIcon}
              data-danger={integrityDanger}
              className="tw:text-primary tw:data-[danger=true]:text-danger"
            />
            <span className="tw:grid tw:min-w-0">
              <strong
                className="tw:text-sm tw:leading-ui tw:text-foreground"
                role={integrityError || chainBroken ? "alert" : "status"}
                aria-live="polite"
              >
                {integrityTitle}
              </strong>
              {integrityError && (
                <span className="tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
                  {t("activity.auditVerifyError", { error: integrityError })}
                </span>
              )}
            </span>
            <span className="tw:inline-flex tw:items-center tw:gap-1 tw:text-xs tw:whitespace-nowrap tw:text-muted-foreground tw:max-[760px]:col-start-2">
              {auditEntries
                ? t("activity.auditDetailsCount", { count: auditEntries.length })
                : t("activity.auditDetails")}
              <Icon
                name="chevronRight"
                className="tw:transition-transform tw:group-open:rotate-90"
              />
            </span>
          </summary>

          <section
            className="tw:grid tw:max-h-[min(48vh,480px)] tw:gap-3 tw:overflow-y-auto tw:border-t tw:border-border-subtle tw:bg-background tw:p-3 tw:focus-visible:outline-2 tw:focus-visible:-outline-offset-2 tw:focus-visible:outline-ring"
            role="region"
            aria-labelledby="activity-audit-summary"
            tabIndex={0}
          >
            <div className="tw:grid tw:min-w-0 tw:gap-1 tw:[&>*]:m-0">
              <h3>{t("activity.auditTitle")}</h3>
              <p className="tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
                {t("activity.auditRecordsDescription")}
              </p>
            </div>

            {auditDetailsError && (
              <div className="tw:text-ui tw:text-danger">
                {t("activity.auditLoadError", { error: auditDetailsError })}
              </div>
            )}
            {auditDetailsLoading && auditEntries === null && <Skeleton lines={4} />}
            {!auditDetailsLoading && auditEntries?.length === 0 && !auditDetailsError && (
              <div className="tw:text-ui tw:leading-relaxed tw:text-muted-foreground">
                {t("activity.auditEmpty")}
              </div>
            )}

            {auditEntries && auditEntries.length > 0 && (
              <ul className="tw:m-0 tw:flex tw:list-none tw:flex-col tw:gap-2 tw:p-0">
                {auditEntries.map((entry) => (
                  <li
                    key={entry.id}
                    data-tampered={entry.id === tamperedId}
                    className="tw:border-b tw:border-border-subtle tw:pb-3 tw:data-[tampered=true]:border-danger"
                  >
                    {entry.id === tamperedId && (
                      <div className="tw:mb-2 tw:flex tw:items-center tw:gap-1 tw:font-semibold tw:text-danger">
                        <Icon name="alert" />
                        {t("activity.auditTampered")}
                      </div>
                    )}
                    <div className="tw:mb-2 tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                      <span
                        data-tone={actionTone(entry.action)}
                        className="badge tw:normal-case tw:data-[tone=danger]:border-danger tw:data-[tone=danger]:text-danger tw:data-[tone=primary]:border-primary tw:data-[tone=primary]:text-primary tw:data-[tone=success]:border-success tw:data-[tone=success]:text-success"
                      >
                        {entry.action}
                      </span>
                      {entry.kind.toLowerCase() !== entry.action.toLowerCase() && (
                        <span className="badge kind">{entry.kind}</span>
                      )}
                      <span className="tw:text-muted-foreground" title={fullTime(entry.ts)}>
                        {relTime(entry.ts)}
                      </span>
                      {entry.approvedBy && (
                        <span className="tw:text-muted-foreground">
                          {t("activity.auditBy", { name: entry.approvedBy })}
                        </span>
                      )}
                    </div>
                    {entry.agentPrompt && (
                      <div className="tw:break-words tw:text-muted-foreground" title={entry.agentPrompt}>
                        “{entry.agentPrompt.length > 120
                          ? `${entry.agentPrompt.slice(0, 120)}…`
                        : entry.agentPrompt}”
                      </div>
                    )}
                    <code className="tw:my-1 tw:block tw:rounded-sm tw:bg-muted tw:px-2 tw:py-0.5 tw:font-mono tw:text-sm tw:whitespace-pre-wrap tw:break-words">
                      {entry.sql}
                    </code>
                    {entry.error && (
                      <div className="tw:text-ui tw:text-danger">{entry.error}</div>
                    )}
                    <div className="tw:break-words tw:font-mono tw:text-xs tw:text-muted-foreground">
                      <span title={entry.prevHash ?? ""}>
                        {t("activity.auditPrev", { hash: short(entry.prevHash) })}
                      </span>
                      {" → "}
                      <span title={entry.hash}>
                        {t("activity.auditHash", { hash: short(entry.hash) })}
                      </span>
                      {entry.affectedEstimate !== null && (
                        <span>
                          {" · "}
                          {t("activity.auditRowsEstimate", { count: entry.affectedEstimate })}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </details>

        <section
          className="tw:grid tw:min-w-0 tw:gap-3 tw:p-3"
          aria-labelledby="activity-query-title"
        >
          <div className="tw:flex tw:items-start tw:justify-between tw:gap-3">
            <div className="tw:grid tw:min-w-0 tw:gap-1 tw:[&>*]:m-0">
              <h3 id="activity-query-title">{t("activity.queries")}</h3>
              <p className="tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
                {t("activity.queriesDescription")}
              </p>
            </div>
            <button className="btn small" onClick={refresh} disabled={busy}>
              {busy ? "..." : t("common.refresh")}
            </button>
          </div>

        {rows.length > 0 && (
          <div className="tw:flex tw:items-center tw:gap-2 tw:max-[760px]:flex-col tw:max-[760px]:items-stretch">
            <input
              className="tw:min-w-0 tw:flex-1"
              type="search"
              placeholder={t("activity.filterSql")}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">{t("activity.allStatuses")}</option>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            <select
              value={originFilter}
              onChange={(event) => setOriginFilter(event.target.value)}
            >
              <option value="">{t("activity.allOrigins")}</option>
              {origins.map((origin) => (
                <option key={origin} value={origin}>
                  {origin}
                </option>
              ))}
            </select>
          </div>
        )}

        {historyError && (
          <div className="tw:text-ui tw:text-danger">
            {t("activity.historyLoadError", { error: historyError })}
          </div>
        )}
        {historyLoading && !historyError && <Skeleton lines={5} />}
        {!historyLoading && !historyError && rows.length === 0 && (
          <div className="tw:text-ui tw:leading-relaxed tw:text-muted-foreground">
            {t("activity.empty", {
              name: connection.name || t("app.thisConnection"),
            })}
          </div>
        )}

        {shown.length > 0 && (
          <div className="tw:min-w-0 tw:overflow-x-auto">
            <table className="tw:w-full tw:border-collapse tw:text-ui tw:[&_th]:border-b tw:[&_th]:border-border-subtle tw:[&_th]:px-3 tw:[&_th]:py-2 tw:[&_th]:text-left tw:[&_th]:text-xs tw:[&_th]:font-semibold tw:[&_th]:tracking-[0.04em] tw:[&_th]:whitespace-nowrap tw:[&_th]:text-muted-foreground tw:[&_th]:uppercase tw:[&_td]:border-b tw:[&_td]:border-border-subtle tw:[&_td]:px-3 tw:[&_td]:py-2 tw:[&_td]:align-middle tw:[&_.num]:text-right tw:max-[760px]:min-w-[720px]">
              <thead>
                <tr>
                  <th>{t("activity.executed")}</th>
                  <th>{t("activity.origin")}</th>
                  <th>{t("activity.kind")}</th>
                  <th>{t("activity.status")}</th>
                  <th className="num">{t("activity.rows")}</th>
                  <th className="num">{t("activity.duration")}</th>
                  <th>{t("activity.sql")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr
                    key={row.id}
                    className="tw:cursor-pointer tw:hover:bg-muted tw:focus-visible:outline-2 tw:focus-visible:-outline-offset-2 tw:focus-visible:outline-ring"
                    role="button"
                    tabIndex={0}
                    onClick={() => load(row.sql)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        load(row.sql);
                      }
                    }}
                    title={t("activity.loadTitle")}
                  >
                    <td className="tw:whitespace-nowrap tw:text-muted-foreground" title={fullTime(row.executedAt)}>
                      {relTime(row.executedAt)}
                    </td>
                    <td>
                      <span
                        data-tone={originTone(row.origin)}
                        className="badge tw:data-[tone=primary]:border-primary tw:data-[tone=primary]:text-primary tw:data-[tone=warning]:border-warning tw:data-[tone=warning]:text-warning"
                      >
                        {row.origin}
                      </span>
                    </td>
                    <td>
                      <span className="badge kind">{row.kind}</span>
                    </td>
                    <td>
                      <span
                        data-tone={statusTone(row.status)}
                        className="badge icon-only-badge tw:data-[tone=danger]:border-danger tw:data-[tone=danger]:text-danger tw:data-[tone=success]:border-success tw:data-[tone=success]:text-success"
                        title={row.error ? `${row.status}: ${row.error}` : row.status}
                        aria-label={row.error ? `${row.status}: ${row.error}` : row.status}
                        role="img"
                      >
                        <Icon name={statusIcon(row.status)} />
                      </span>
                    </td>
                    <td className="num">{row.rowCount ?? "—"}</td>
                    <td className="num">{duration(row.durationMs)}</td>
                    <td className="tw:w-full tw:max-w-0" title={row.sql}>
                      <code className="tw:block tw:overflow-hidden tw:font-mono tw:text-sm tw:text-ellipsis tw:whitespace-nowrap">
                        {firstLine(row.sql)}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.length > 0 && filtered.length === 0 && (
          <div className="tw:text-ui tw:leading-relaxed tw:text-muted-foreground">
            {t("activity.noMatches")}
          </div>
        )}

        {filtered.length > CAP && (
          <div className="tw:text-sm tw:text-muted-foreground">
            {t("activity.matching", { cap: CAP, count: filtered.length })}
          </div>
        )}
        </section>
      </div>
    </WorkbenchPane>
  );
}
