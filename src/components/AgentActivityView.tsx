// Read-only activity, context, and policy view for authenticated Terminal commands.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon";
import InfoTip from "./InfoTip";
import { PanelTabs } from "../design-system/components/PanelTabs";
import { fullTime } from "../lib/relTime";
import {
  useOperationActivity,
  type OperationActivity,
} from "../lib/operationActivity";
import { useI18n, type I18nKey } from "../lib/i18n";

type AgentView = "activity" | "context" | "audit";

function contextSummaryKey(item: OperationActivity): I18nKey {
  return item.error
    ? "agent.contextSummaryError"
    : "agent.contextSummaryDefault";
}

function payloadRows(payload: Record<string, unknown>) {
  return Object.entries(payload).filter(
    ([, value]) => value !== undefined && value !== null,
  );
}

function displayValue(value: unknown) {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) =>
        typeof item === "string" ? item : JSON.stringify(item),
      )
      .join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function Timeline({
  feed,
  selected,
  onSelect,
}: {
  feed: OperationActivity[];
  selected: OperationActivity | null;
  onSelect: (item: OperationActivity) => void;
}) {
  return (
    <ul className="tw:m-0 tw:flex tw:max-h-full tw:list-none tw:flex-col tw:gap-0.5 tw:overflow-auto tw:p-0">
      {feed.map((item) => (
        <li
          key={item.id}
          data-error={!!item.error}
          data-selected={selected?.id === item.id}
          className="tw:grid tw:cursor-pointer tw:grid-cols-[80px_150px_28px_minmax(0,1fr)] tw:items-baseline tw:gap-2 tw:rounded-sm tw:px-2 tw:py-1 tw:text-ui tw:data-[selected=true]:bg-selection tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring tw:@max-[760px]:grid-cols-[68px_112px_24px_minmax(0,1fr)]"
          role="button"
          tabIndex={0}
          onClick={() => onSelect(item)}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(item);
            }
          }}
        >
          <span className="tw:font-mono tw:text-xs tw:text-muted-foreground" title={fullTime(item.iso)}>
            {item.ts}
          </span>
          <span className="tw:font-medium">{item.tool}</span>
          <span
            data-error={!!item.error}
            className="tw:text-success tw:data-[error=true]:text-danger"
          >
            {item.error ? "!" : "ok"}
          </span>
          <span
            data-error={!!item.error}
            className="tw:overflow-hidden tw:font-mono tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap tw:data-[error=true]:text-danger"
            title={item.detail}
          >
            {item.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AgentEmptyState() {
  const { t } = useI18n();
  const items: {
    icon: "database" | "play" | "circleSlash" | "alert";
    title: I18nKey;
    body: I18nKey;
    tone: "trust" | "risk" | "danger";
  }[] = [
    {
      icon: "database",
      title: "agent.schemaAccess",
      body: "agent.schemaAccessBody",
      tone: "trust",
    },
    {
      icon: "play",
      title: "agent.dataAccess",
      body: "agent.dataAccessBody",
      tone: "trust",
    },
    {
      icon: "circleSlash",
      title: "agent.schemaModification",
      body: "agent.schemaModificationBody",
      tone: "risk",
    },
    {
      icon: "alert",
      title: "agent.dataModification",
      body: "agent.dataModificationBody",
      tone: "danger",
    },
  ];

  return (
    <div className="tw:grid tw:grid-cols-[minmax(220px,280px)_minmax(0,1fr)] tw:items-start tw:gap-3 tw:@max-[1100px]:grid-cols-1">
      <div>
        <div className="tw:inline-flex tw:items-center tw:gap-2">
          <h3>{t("agent.ledgerTitle")}</h3>
          <InfoTip label={t("agent.emptyBody")} />
        </div>
      </div>
      <div
        className="tw:grid tw:grid-cols-2 tw:gap-2 tw:@max-[1100px]:grid-cols-1"
        aria-label={t("agent.emptyCards")}
      >
        {items.map((item) => (
          <div
            data-tone={item.tone}
            className="ds-card ds-card-stack tw:min-h-[80px] tw:data-[tone=danger]:border-danger tw:data-[tone=risk]:border-warning tw:data-[tone=trust]:border-success"
            key={item.title}
            title={t(item.body)}
          >
            <div className="ds-card-title-row">
              <Icon name={item.icon} />
              <strong>{t(item.title)}</strong>
              <InfoTip label={t(item.body)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AgentActivityView({
  compact = false,
  connectionId,
}: {
  compact?: boolean;
  connectionId?: string;
}) {
  const { t } = useI18n();
  const { feed: allFeed } = useOperationActivity();
  const feed = useMemo(
    () =>
      connectionId
        ? allFeed.filter((item) => item.connectionId === connectionId)
        : allFeed,
    [allFeed, connectionId],
  );
  const latest = feed[0] ?? null;
  const [view, setView] = useState<AgentView>("activity");
  const [selected, setSelected] = useState<OperationActivity | null>(latest);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (latest && following) setSelected(latest);
  }, [following, latest]);
  useEffect(() => {
    if (selected && !feed.some((item) => item.id === selected.id)) {
      setSelected(latest);
      setFollowing(true);
    }
  }, [feed, latest, selected]);
  const selectItem = (item: OperationActivity) => {
    setSelected(item);
    setFollowing(item.id === latest?.id);
  };

  const stats = useMemo(() => {
    const errors = feed.filter((item) => item.error).length;
    return {
      operations: feed.length,
      succeeded: feed.length - errors,
      errors,
    };
  }, [feed]);
  const errorItems = feed.filter((item) => item.error);

  return (
    <div className="tw:flex tw:h-full tw:min-h-0 tw:flex-col tw:gap-3">
      <header className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:@max-[1100px]:flex-col tw:@max-[1100px]:items-start">
        {!compact && (
          <div>
            <div className="tw:inline-flex tw:items-center tw:gap-2">
              <h2>{t("agent.workspace")}</h2>
              <InfoTip label={t("agent.contextHelp")} />
            </div>
          </div>
        )}
        <div
          className="tw:ml-auto tw:flex tw:flex-wrap tw:justify-end tw:gap-2 tw:@max-[1100px]:ml-0 tw:@max-[1100px]:justify-start"
          aria-label={t("agent.session")}
        >
          <span
            className="tw:inline-flex tw:min-h-6 tw:items-center tw:gap-1 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:px-2 tw:text-xs tw:text-muted-foreground tw:[&_.icon]:text-sm"
            title={t("agent.operations", { count: stats.operations })}
            aria-label={t("agent.operations", { count: stats.operations })}
          >
            <Icon name="terminal" />
            {stats.operations}
          </span>
          <span
            className="tw:inline-flex tw:min-h-6 tw:items-center tw:gap-1 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:px-2 tw:text-xs tw:text-muted-foreground tw:[&_.icon]:text-sm"
            title={t("agent.succeeded", { count: stats.succeeded })}
            aria-label={t("agent.succeeded", { count: stats.succeeded })}
          >
            <Icon name="check" />
            {stats.succeeded}
          </span>
          <span
            className="tw:inline-flex tw:min-h-6 tw:items-center tw:gap-1 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:px-2 tw:text-xs tw:text-muted-foreground tw:[&_.icon]:text-sm"
            title={t("agent.errorCount", { count: stats.errors })}
            aria-label={t("agent.errorCount", { count: stats.errors })}
          >
            <Icon name={stats.errors ? "alert" : "check"} />
            {stats.errors}
          </span>
        </div>
      </header>

      <PanelTabs
        tabs={[
          { id: "activity", label: t("agent.activity") },
          { id: "context", label: t("agent.context") },
          { id: "audit", label: t("agent.audit") },
        ]}
        active={view}
        onChange={setView}
        label={t("agent.workspace")}
      />

      {feed.length === 0 ? (
        <AgentEmptyState />
      ) : view === "activity" ? (
        <section className="tw:min-w-0 tw:overflow-auto tw:py-2">
          <div className="tw:mb-2 tw:flex tw:items-center tw:justify-between tw:gap-3">
            <h3 className="tw:mt-0">{t("agent.activity")}</h3>
            {!following && latest && (
              <button
                className="btn small"
                onClick={() => {
                  setSelected(latest);
                  setFollowing(true);
                }}
              >
                {t("agent.jumpLatest")}
              </button>
            )}
          </div>
          <Timeline feed={feed} selected={selected} onSelect={selectItem} />
        </section>
      ) : view === "context" ? (
        <div className="tw:grid tw:min-h-0 tw:flex-1 tw:grid-cols-[minmax(0,1fr)_minmax(264px,336px)] tw:gap-3 tw:@max-[1100px]:grid-cols-1">
          <section className="tw:min-w-0 tw:overflow-auto tw:py-2">
            <div className="tw:mb-2 tw:flex tw:items-center tw:justify-between tw:gap-3">
              <h3 className="tw:mt-0">{t("agent.contextExposed")}</h3>
              {selected && (
                <span className="tw:text-muted-foreground">
                  {selected.tool} · {selected.ts}
                </span>
              )}
            </div>
            {selected ? (
              <div className="tw:grid tw:gap-3">
                <p className="tw:m-0 tw:leading-[1.45] tw:text-foreground">
                  {t(contextSummaryKey(selected))}
                </p>
                <div className="tw:grid tw:overflow-hidden tw:rounded-sm tw:border tw:border-border-subtle">
                  {payloadRows(selected.payload).map(([key, value]) => (
                    <div
                      className="tw:grid tw:grid-cols-[160px_minmax(0,1fr)] tw:gap-3 tw:border-b tw:border-border-subtle tw:px-3 tw:py-2 tw:text-sm tw:last:border-b-0 tw:@max-[760px]:grid-cols-1 tw:@max-[760px]:gap-1"
                      key={key}
                    >
                      <span className="tw:text-muted-foreground">{key}</span>
                      <code className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
                        {displayValue(value)}
                      </code>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="tw:text-muted-foreground">
                {t("agent.noSelection")}
              </p>
            )}
          </section>
          <aside className="tw:min-w-0 tw:overflow-auto tw:border-l tw:border-border-subtle tw:py-2 tw:pl-3 tw:@max-[1100px]:border-t tw:@max-[1100px]:border-l-0 tw:@max-[1100px]:pt-3 tw:@max-[1100px]:pl-0">
            <h3 className="tw:mt-0">{t("agent.timeline")}</h3>
            <Timeline
              feed={feed}
              selected={selected}
              onSelect={selectItem}
            />
          </aside>
        </div>
      ) : (
        <div className="tw:grid tw:grid-cols-[repeat(auto-fit,minmax(190px,1fr))] tw:gap-3 tw:@max-[1100px]:grid-cols-1">
          <section
            className="ds-card ds-card-row tw:min-h-[64px] tw:border-success tw:[&>div]:inline-flex tw:[&>div]:min-w-0 tw:[&>div]:items-center tw:[&>div]:gap-1"
            title={t("agent.auditReadOnlyBody")}
          >
            <Icon name="database" />
            <div>
              <strong>{t("agent.auditReadOnly")}</strong>
              <InfoTip label={t("agent.auditReadOnlyBody")} />
            </div>
          </section>
          <section
            className="ds-card ds-card-row tw:min-h-[64px] tw:border-danger tw:[&>div]:inline-flex tw:[&>div]:min-w-0 tw:[&>div]:items-center tw:[&>div]:gap-1"
            title={t("agent.auditBlockedWritesBody")}
          >
            <Icon name="circleSlash" />
            <div>
              <strong>{t("agent.auditBlockedWrites")}</strong>
              <InfoTip label={t("agent.auditBlockedWritesBody")} />
            </div>
          </section>
          <section
            className="ds-card ds-card-row tw:min-h-[64px] tw:[&>div]:inline-flex tw:[&>div]:min-w-0 tw:[&>div]:items-center tw:[&>div]:gap-1"
            title={t("agent.auditHashChainBody")}
          >
            <Icon name="check" />
            <div>
              <strong>{t("agent.auditHashChain")}</strong>
              <InfoTip label={t("agent.auditHashChainBody")} />
            </div>
          </section>
          <section className="ds-panel tw:col-span-full tw:min-h-[96px] tw:min-w-0">
            <div className="tw:mb-2 tw:flex tw:items-center tw:justify-between tw:gap-3">
              <h3 className="tw:mt-0">{t("agent.policy")}</h3>
              <span
                data-error={errorItems.length > 0}
                className="badge icon-only-badge tw:data-[error=false]:border-success tw:data-[error=false]:text-success tw:data-[error=true]:border-danger tw:data-[error=true]:text-danger"
                title={
                  errorItems.length
                    ? t("agent.auditErrors", { count: errorItems.length })
                    : t("agent.auditNoErrors")
                }
                aria-label={
                  errorItems.length
                    ? t("agent.auditErrors", { count: errorItems.length })
                    : t("agent.auditNoErrors")
                }
                role="img"
              >
                <Icon name={errorItems.length ? "alert" : "check"} />
              </span>
            </div>
            {errorItems.length ? (
              <Timeline
                feed={errorItems}
                selected={selected}
                onSelect={selectItem}
              />
            ) : (
              <InfoTip label={t("agent.auditNoErrors")} />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
