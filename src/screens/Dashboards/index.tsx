// Connection-scoped dashboard canvas. Every saved Agent query becomes one live tile,
// mirroring Chat2DB's at-a-glance report surface while retaining DopeDB's read-only
// execution boundary and explicit per-tile refresh/delete controls.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Dashboard,
  DashboardKind,
} from "../../features/dashboards/domain";
import { deleteDashboard } from "../../features/dashboards/tauriAdapter";
import type { QueryResult } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import ConfirmButton from "../../components/ConfirmButton";
import DashboardVisualizationView from "../../components/DashboardVisualization";
import { Icon } from "../../components/Icon";
import Skeleton from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import {
  MetadataDot,
  WorkbenchEmptyState,
  WorkbenchPane,
} from "../../design-system/components/Workbench";
import {
  ToolWindowHeader,
  ToolWindowHideButton,
  ToolWindowSearchRow,
  ToolWindowSideSurface,
} from "../../design-system/components/ToolWindow";
import { dashboardTileRunQueries, dashboardsQuery, qk } from "../../lib/queries";
import { useI18n, type I18nKey } from "../../lib/i18n";

const KIND_LABELS: Record<DashboardKind, I18nKey> = {
  auto: "dashboard.kindAuto",
  bar: "dashboard.kindBar",
  line: "dashboard.kindLine",
  metric: "dashboard.kindMetric",
  table: "dashboard.kindTable",
};

function displayTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function DashboardSidebar({
  connections,
  selectedId,
  focusId,
  onSelectConnection,
  onFocus,
  onClose,
  workspaceAccount,
  workspaceHeader,
  compact = false,
  compactOpen = false,
}: {
  connections: ConnectionProfile[];
  selectedId: string | null;
  focusId: string | null;
  onSelectConnection: (id: string) => void;
  onFocus: (id: string) => void;
  onClose: () => void;
  workspaceAccount?: ReactNode;
  workspaceHeader?: ReactNode;
  compact?: boolean;
  compactOpen?: boolean;
}) {
  const { t } = useI18n();
  const selected = connections.find((connection) => connection.id === selectedId) ?? null;
  const list = useQuery({
    ...dashboardsQuery(selectedId ?? "__no_connection__"),
    enabled: selectedId !== null,
  });
  const dashboards = list.data ?? [];

  return (
    <ToolWindowSideSurface
      compact={compact}
      compactOpen={compactOpen}
      id="workbench-sidebar"
    >
      {workspaceHeader}
      <ToolWindowHeader
        title={
          <span className="tw:inline-flex tw:min-w-0 tw:items-baseline tw:gap-2">
            <span className="tw:truncate">{t("dashboard.library")}</span>
            <span className="tw:font-normal tw:text-muted-foreground tw:tabular-nums">
              {dashboards.length}
            </span>
          </span>
        }
        actions={
          <ToolWindowHideButton
            label={t("common.close")}
            onClick={onClose}
          />
        }
      />
      <ToolWindowSearchRow>
        <label className="tw:flex tw:min-w-0 tw:flex-1 tw:items-center">
          <span className="tw:sr-only">{t("app.thisConnection")}</span>
          <select
            className="tw:h-control-sm tw:w-full tw:min-w-0 tw:border-0 tw:bg-transparent tw:px-2 tw:text-sm tw:shadow-none"
            value={selectedId ?? ""}
            onChange={(event) => onSelectConnection(event.target.value)}
            aria-label={t("app.thisConnection")}
          >
            <option value="" disabled>
              {t("settings.selectConnectionTitle")}
            </option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name || t("app.unnamed")}
              </option>
            ))}
          </select>
        </label>
      </ToolWindowSearchRow>

      <div className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:overflow-hidden tw:p-1">
        <div className="tw:grid tw:min-h-0 tw:content-start tw:gap-1 tw:overflow-y-auto tw:[&>p]:m-2 tw:[&>p]:text-sm tw:[&>p]:leading-relaxed">
          {!selected ? (
            <p className="tw:text-muted-foreground">
              {t("settings.selectConnectionTitle")}
            </p>
          ) : list.isPending ? (
            <Skeleton lines={4} />
          ) : list.error ? (
            <p className="tw:text-danger">{errMessage(list.error)}</p>
          ) : dashboards.length === 0 ? (
            <p className="tw:text-muted-foreground">
              {t("dashboard.emptyTitle")}
            </p>
          ) : (
            dashboards.map((dashboard) => (
              <button
                type="button"
                key={dashboard.id}
                data-active={focusId === dashboard.id}
                className="tw:grid tw:min-h-control-xl tw:min-w-0 tw:cursor-pointer tw:grid-cols-[var(--ds-control-sm)_minmax(0,1fr)] tw:items-center tw:gap-2 tw:rounded-sm tw:border-0 tw:bg-transparent tw:p-2 tw:text-left tw:text-muted-foreground tw:data-[active=true]:bg-muted tw:data-[active=true]:text-foreground tw:data-[active=true]:shadow-[inset_var(--ds-border-width-bold)_0_0_var(--ds-accent-text)] tw:hover:bg-muted tw:hover:text-foreground tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
                onClick={() => onFocus(dashboard.id)}
                title={dashboard.title}
              >
                <Icon name="chart" />
                <span className="tw:grid tw:min-w-0 tw:gap-1">
                  <strong className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
                    {dashboard.title}
                  </strong>
                  <small className="tw:overflow-hidden tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
                    {t(KIND_LABELS[dashboard.visualization.kind])}
                  </small>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
      {workspaceAccount ? (
        <div className="ds-control-row tw:flex tw:min-w-0 tw:shrink-0 tw:items-center tw:gap-2 tw:border-t tw:border-border-subtle tw:bg-background tw:p-2">
          {workspaceAccount}
        </div>
      ) : null}
    </ToolWindowSideSurface>
  );
}

function DashboardTile({
  dashboard,
  result,
  running,
  error,
  deleting,
  selected,
  onRefresh,
  onDelete,
}: {
  dashboard: Dashboard;
  result: QueryResult | null;
  running: boolean;
  error: string | null;
  deleting: boolean;
  selected: boolean;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <article
      id={`dashboard-${dashboard.id}`}
      data-dashboard-tile
      data-kind={dashboard.visualization.kind}
      data-selected={selected}
      aria-label={dashboard.title}
      className="tw:flex tw:min-h-[300px] tw:min-w-0 tw:flex-col tw:gap-2 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3 tw:shadow-panel tw:data-[kind=metric]:min-h-[220px] tw:data-[kind=table]:col-span-full tw:data-[selected=true]:border-border-strong tw:focus:outline-none tw:focus-visible:border-ring tw:focus-visible:ring-2 tw:focus-visible:ring-ring tw:motion-reduce:scroll-auto tw:@max-[1180px]:data-[kind=table]:col-auto"
      tabIndex={-1}
    >
      <header className="tw:flex tw:min-w-0 tw:items-start tw:justify-between tw:gap-3 tw:@max-[760px]:gap-2">
        <div className="tw:grid tw:min-w-0 tw:gap-1">
          <div className="ds-title-line tw:flex-nowrap">
            <Icon name="chart" className="tw:shrink-0 tw:text-primary" />
            <strong className="tw:min-w-0 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
              {dashboard.title}
            </strong>
            <span className="badge kind">
              {t(KIND_LABELS[dashboard.visualization.kind])}
            </span>
          </div>
          {dashboard.description && (
            <p className="tw:m-0 tw:line-clamp-2 tw:text-sm tw:leading-ui tw:text-muted-foreground">
              {dashboard.description}
            </p>
          )}
        </div>
        <div className="ds-control-row tw:flex tw:shrink-0 tw:gap-1">
          <button
            type="button"
            className="btn small icon-only"
            disabled={running || deleting}
            onClick={onRefresh}
            title={t(selected ? "dashboard.refresh" : "dashboard.clickToRun")}
            aria-label={t(selected ? "dashboard.refresh" : "dashboard.clickToRun")}
          >
            <Icon name={selected ? "refresh" : "play"} />
          </button>
          <ConfirmButton
            label={t("common.delete")}
            disabled={running || deleting}
            iconOnly
            size="compact"
            variant="danger"
            confirmLabel={t("dashboard.deleteConfirm")}
            onConfirm={onDelete}
          >
            <Icon name="trash" />
          </ConfirmButton>
        </div>
      </header>

      <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:overflow-hidden tw:text-xs tw:whitespace-nowrap tw:text-muted-foreground tw:tabular-nums tw:[&>span:last-child]:overflow-hidden tw:[&>span:last-child]:text-ellipsis tw:[&_time]:overflow-hidden tw:[&_time]:text-ellipsis">
        <time dateTime={dashboard.updatedAt}>{displayTime(dashboard.updatedAt)}</time>
        {result && (
          <>
            <MetadataDot />
            <span>
              {t("dashboard.resultMeta", {
                count: result.rowCount,
                duration: result.durationMs,
              })}
            </span>
          </>
        )}
      </div>

      {error ? (
        <div className="tw:text-ui tw:text-danger" role="alert">{error}</div>
      ) : running && !result ? (
        <div className="tw:grid tw:min-h-[160px] tw:flex-1 tw:place-items-center tw:text-center" aria-busy="true">
          <span>{t("dashboard.running")}</span>
        </div>
      ) : result ? (
        <DashboardVisualizationView
          compact
          result={result}
          visualization={dashboard.visualization}
        />
      ) : (
        <div className="tw:grid tw:min-h-[160px] tw:flex-1 tw:place-items-center tw:text-center tw:text-muted-foreground">
          {t("dashboard.clickToRun")}
        </div>
      )}

      <details className="tw:mt-auto tw:border-t tw:border-border-subtle tw:pt-2">
        <summary className="tw:w-fit tw:cursor-pointer tw:rounded-xs tw:text-xs tw:text-muted-foreground tw:hover:text-foreground tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring">
          {t("dashboard.sql")}
        </summary>
        <code className="tw:mt-2 tw:block tw:max-h-[120px] tw:overflow-auto tw:rounded-sm tw:bg-muted tw:p-2 tw:font-mono tw:text-xs tw:leading-relaxed tw:whitespace-pre-wrap tw:break-all tw:text-foreground">
          {dashboard.sql}
        </code>
      </details>
    </article>
  );
}

export default function Dashboards({
  connection,
  focusId,
  onFocusConsumed,
  onOpenAgent,
}: {
  connection: ConnectionProfile;
  focusId: string | null;
  onFocusConsumed: () => void;
  onOpenAgent: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const appliedFocusId = useRef<string | null>(null);

  const list = useQuery(dashboardsQuery(connection.id));
  const dashboards = useMemo(() => list.data ?? [], [list.data]);
  const runs = useQueries({
    queries: dashboardTileRunQueries(
      dashboards.map((dashboard) => dashboard.id),
      selectedId,
    ),
  });

  const remove = useMutation({
    mutationFn: deleteDashboard,
    onSuccess: (_, removedId) => {
      queryClient.removeQueries({ queryKey: qk.dashboardRun(removedId) });
      void queryClient.invalidateQueries({ queryKey: qk.dashboards(connection.id) });
      setSelectedId((current) => (current === removedId ? null : current));
      toast(t("dashboard.deleted"));
    },
  });

  useEffect(() => {
    setSelectedId(null);
    appliedFocusId.current = null;
  }, [connection.id]);

  useEffect(() => {
    if (!focusId || appliedFocusId.current === focusId) return;
    if (!dashboards.some((dashboard) => dashboard.id === focusId)) return;
    appliedFocusId.current = focusId;
    onFocusConsumed();
    if (selectedId && selectedId !== focusId) {
      void queryClient.cancelQueries({ queryKey: qk.dashboardRun(selectedId) });
    }
    setSelectedId(focusId);
    window.requestAnimationFrame(() => {
      const tile = document.getElementById(`dashboard-${focusId}`);
      tile?.scrollIntoView({ block: "center", behavior: "smooth" });
      tile?.focus({ preventScroll: true });
    });
  }, [dashboards, focusId, onFocusConsumed, queryClient, selectedId]);

  function execute(dashboard: Dashboard) {
    remove.reset();
    if (dashboard.id === selectedId) {
      void queryClient.invalidateQueries({ queryKey: qk.dashboardRun(dashboard.id) });
      return;
    }
    if (selectedId) {
      void queryClient.cancelQueries({ queryKey: qk.dashboardRun(selectedId) });
    }
    setSelectedId(dashboard.id);
  }

  const loading = list.isPending;
  const loadError = list.error ? errMessage(list.error) : null;
  const deleteError = remove.error ? errMessage(remove.error) : null;

  return (
    <WorkbenchPane>
      <div className="tw:mx-auto tw:grid tw:min-h-0 tw:w-full tw:max-w-[1440px] tw:flex-1 tw:content-start tw:gap-3 tw:overflow-auto tw:p-3">
      {loadError && (
        <div className="tw:break-all tw:text-ui tw:text-danger" role="alert">
          {t("dashboard.loadFailed", { error: loadError })}
        </div>
      )}
      {deleteError && (
        <div className="tw:break-all tw:text-ui tw:text-danger" role="alert">
          {deleteError}
        </div>
      )}

      {loading ? (
        <section className="tw:min-h-[240px] tw:p-3">
          <Skeleton lines={3} />
        </section>
      ) : loadError ? null : dashboards.length === 0 ? (
        <WorkbenchEmptyState icon="chart">
          <h3>{t("dashboard.emptyTitle")}</h3>
          <p className="tw:m-0 tw:max-w-[56ch] tw:leading-relaxed tw:text-pretty tw:text-muted-foreground">
            {t("dashboard.emptyBody")}
          </p>
          <button className="btn primary" onClick={onOpenAgent}>
            <Icon name="terminal" />
            {t("dashboard.openAgent")}
          </button>
        </WorkbenchEmptyState>
      ) : (
        <>
          <header className="tw:flex tw:min-h-control-lg tw:min-w-0 tw:items-center tw:justify-between tw:gap-3 tw:@max-[760px]:items-start">
            <div className="tw:flex tw:min-w-0 tw:items-baseline tw:gap-2">
              <strong>{t("dashboard.library")}</strong>
              <span className="tw:text-sm tw:text-muted-foreground tw:tabular-nums">
                {dashboards.length}
              </span>
            </div>
            <button className="btn small" onClick={onOpenAgent}>
              <Icon name="terminal" />
              {t("dashboard.openAgent")}
            </button>
          </header>
          <section
            data-dashboard-grid
            className="tw:grid tw:min-w-0 tw:grid-cols-2 tw:auto-rows-auto tw:grid-flow-dense tw:gap-3 tw:@max-[1180px]:grid-cols-1"
            aria-label={t("dashboard.library")}
          >
            {dashboards.map((dashboard, index) => {
              const run = runs[index];
              return (
                <DashboardTile
                  key={dashboard.id}
                  dashboard={dashboard}
                  result={run?.data ?? null}
                  running={run?.isFetching ?? false}
                  error={run?.error ? errMessage(run.error) : null}
                  deleting={remove.isPending && remove.variables === dashboard.id}
                  selected={dashboard.id === selectedId}
                  onRefresh={() => execute(dashboard)}
                  onDelete={() => remove.mutate(dashboard.id)}
                />
              );
            })}
          </section>
        </>
      )}
      </div>
    </WorkbenchPane>
  );
}
