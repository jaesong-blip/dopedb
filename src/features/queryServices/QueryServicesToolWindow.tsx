import { useEffect, useMemo, useState } from "react";

import { Icon } from "../../components/Icon";
import { StatusDot } from "../../design-system/components/Status";
import { ToolWindowHeader } from "../../design-system/components/ToolWindow";
import { useI18n } from "../../lib/i18n";
import type {
  QueryServiceSession,
  QueryServiceStatus,
} from "./domain";
import QueryServiceResult from "./QueryServiceResult";

type ServicesTab = "output" | "result";

export default function QueryServicesToolWindow({
  sessions,
  activeSessionId,
  onActivate,
  onClose,
  onStartResize,
  onResetHeight,
}: {
  sessions: QueryServiceSession[];
  activeSessionId: string | null;
  onActivate: (id: string) => void;
  onClose: () => void;
  onStartResize: (event: {
    preventDefault(): void;
    clientY: number;
  }) => void;
  onResetHeight: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<ServicesTab>("result");
  const active =
    sessions.find((session) => session.id === activeSessionId) ??
    sessions[0] ??
    null;

  useEffect(() => {
    if (!activeSessionId && sessions[0]) onActivate(sessions[0].id);
  }, [activeSessionId, onActivate, sessions]);

  return (
    <section
      className="services-tool-window tw:relative tw:mx-1 tw:mb-1 tw:flex tw:min-h-0 tw:min-w-0 tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-background"
      aria-label={t("services.title")}
    >
      <div
        className="tw:absolute tw:-top-1 tw:right-0 tw:left-0 tw:z-[var(--ds-z-raised)] tw:h-2 tw:cursor-row-resize tw:hover:bg-ring/30 tw:active:bg-ring/30"
        title={t("app.dragResize")}
        onMouseDown={onStartResize}
        onDoubleClick={onResetHeight}
      />
      <aside className="tw:flex tw:w-[220px] tw:shrink-0 tw:flex-col tw:border-r tw:border-border-subtle tw:bg-card">
        <ToolWindowHeader title={t("services.title")} />
        <div
          className="tw:min-h-0 tw:flex-1 tw:overflow-auto tw:p-1"
          role="tree"
          aria-label={t("services.sessions")}
        >
          {sessions.length === 0 ? (
            <p className="tw:m-0 tw:p-3 tw:text-sm tw:text-muted-foreground">
              {t("services.empty")}
            </p>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                role="treeitem"
                data-active={session.id === active?.id}
                className="tw:grid tw:w-full tw:min-w-0 tw:cursor-pointer tw:grid-cols-[var(--ds-control-sm)_minmax(0,1fr)] tw:items-start tw:gap-1 tw:rounded-sm tw:border-0 tw:bg-transparent tw:px-1 tw:py-1.5 tw:font-sans tw:text-left tw:text-foreground tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:hover:bg-muted"
                onClick={() => onActivate(session.id)}
                aria-selected={session.id === active?.id}
              >
                <span className="tw:grid tw:h-control-sm tw:place-items-center">
                  <StatusDot tone={statusTone(session.status)} />
                </span>
                <span className="tw:grid tw:min-w-0 tw:gap-[var(--ds-segment-gap)]">
                  <strong className="tw:overflow-hidden tw:text-sm tw:font-medium tw:text-ellipsis tw:whitespace-nowrap">
                    {session.consoleTitle}
                  </strong>
                  <small className="tw:overflow-hidden tw:text-2xs tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
                    {session.connectionName} · {session.startedLabel}
                  </small>
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <div className="tw:flex tw:min-w-0 tw:flex-1 tw:flex-col">
        <div className="tw:flex tw:h-control-md tw:shrink-0 tw:items-end tw:border-b tw:border-border-subtle tw:bg-card tw:px-1">
          <div
            className="tw:flex tw:min-w-0 tw:flex-1 tw:items-end"
            role="tablist"
            aria-label={t("services.tabs")}
          >
            {(["output", "result"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                data-active={tab === id}
                className="tw:relative tw:h-control-md tw:cursor-pointer tw:border-0 tw:bg-transparent tw:px-3 tw:font-sans tw:text-sm tw:text-muted-foreground tw:data-[active=true]:text-foreground tw:data-[active=true]:after:absolute tw:data-[active=true]:after:right-2 tw:data-[active=true]:after:bottom-0 tw:data-[active=true]:after:left-2 tw:data-[active=true]:after:h-0.5 tw:data-[active=true]:after:bg-primary tw:hover:text-foreground"
                onClick={() => setTab(id)}
              >
                {t(
                  id === "output"
                    ? "services.outputTab"
                    : "services.resultTab",
                )}
              </button>
            ))}
          </div>
          {active && (
            <span className="tw:mb-1 tw:inline-flex tw:h-control-sm tw:max-w-[min(42vw,420px)] tw:items-center tw:gap-1 tw:overflow-hidden tw:px-2 tw:text-xs tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
              <StatusDot tone={statusTone(active.status)} />
              {statusLabel(active.status, t)}
            </span>
          )}
          <button
            type="button"
            className="btn small icon-only icon-xs tw:mb-1"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:overflow-auto">
          {!active ? (
            <div className="tw:m-auto tw:grid tw:justify-items-center tw:gap-2 tw:p-6 tw:text-center tw:text-sm tw:text-muted-foreground">
              <Icon name="list" className="tw:text-xl" />
              {t("services.empty")}
            </div>
          ) : tab === "output" ? (
            <ServiceOutput session={active} />
          ) : (
            <QueryServiceResult key={active.id} result={active.result} />
          )}
        </div>
      </div>
    </section>
  );
}

function ServiceOutput({ session }: { session: QueryServiceSession }) {
  const { t } = useI18n();
  const lines = useMemo(
    () => [
      `[${session.startedLabel}] ${t("services.started", {
        connection: session.connectionName,
      })}`,
      "",
      session.sql,
      "",
      statusLabel(session.status, t),
    ],
    [session, t],
  );

  return (
    <pre className="tw:m-0 tw:min-h-full tw:overflow-auto tw:p-3 tw:font-mono tw:text-xs tw:leading-body tw:whitespace-pre-wrap tw:text-foreground">
      {lines.join("\n")}
    </pre>
  );
}

function statusTone(status: QueryServiceStatus) {
  if (status === "completed") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "running" || status === "waiting") return "warning" as const;
  return "neutral" as const;
}

function statusLabel(
  status: QueryServiceStatus,
  t: ReturnType<typeof useI18n>["t"],
) {
  return t(`services.status.${status}`);
}
