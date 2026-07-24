// Read-only activity, context, and policy view for authenticated Terminal commands.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon";
import InfoTip from "./InfoTip";
import { fullTime } from "../lib/relTime";
import {
  useOperationActivity,
  type OperationActivity,
} from "../lib/operationActivity";
import { useI18n, type I18nKey } from "../lib/i18n";
import "./AgentActivityView.css";

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
    <ul className="agent-feed agent-timeline">
      {feed.map((item) => (
        <li
          key={item.id}
          className={`act ${item.error ? "error" : "result"}${
            selected?.id === item.id ? " sel" : ""
          }`}
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
          <span className="act-ts" title={fullTime(item.iso)}>
            {item.ts}
          </span>
          <span className="act-tool">{item.tool}</span>
          <span className="act-kind">{item.error ? "!" : "ok"}</span>
          <span className="act-detail" title={item.detail}>
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
    <div className="agent-empty-panel">
      <div className="agent-empty-copy">
        <div className="agent-empty-title">
          <h3>{t("agent.ledgerTitle")}</h3>
          <InfoTip label={t("agent.emptyBody")} />
        </div>
      </div>
      <div
        className="agent-empty-rows ds-card-grid"
        aria-label={t("agent.emptyCards")}
      >
        {items.map((item) => (
          <div
            className={`agent-empty-row ds-card ds-card-stack ds-tone-${item.tone}`}
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
    <div className="agent-workspace">
      <header className="agent-head">
        {!compact && (
          <div>
            <div className="agent-title-row">
              <h2>{t("agent.workspace")}</h2>
              <InfoTip label={t("agent.contextHelp")} />
            </div>
          </div>
        )}
        <div className="agent-stats" aria-label={t("agent.session")}>
          <span
            title={t("agent.operations", { count: stats.operations })}
            aria-label={t("agent.operations", { count: stats.operations })}
          >
            <Icon name="terminal" />
            {stats.operations}
          </span>
          <span
            title={t("agent.succeeded", { count: stats.succeeded })}
            aria-label={t("agent.succeeded", { count: stats.succeeded })}
          >
            <Icon name="check" />
            {stats.succeeded}
          </span>
          <span
            title={t("agent.errorCount", { count: stats.errors })}
            aria-label={t("agent.errorCount", { count: stats.errors })}
          >
            <Icon name={stats.errors ? "alert" : "check"} />
            {stats.errors}
          </span>
        </div>
      </header>

      <div className="agent-view-tabs ds-control-row" role="tablist">
        {(["activity", "context", "audit"] as AgentView[]).map((id) => (
          <button
            key={id}
            className={view === id ? "seg active" : "seg"}
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
          >
            {id === "activity"
              ? t("agent.activity")
              : id === "context"
                ? t("agent.context")
                : t("agent.audit")}
          </button>
        ))}
      </div>

      {feed.length === 0 ? (
        <AgentEmptyState />
      ) : view === "activity" ? (
        <section className="agent-primary">
          <div className="agent-section-head">
            <h3>{t("agent.activity")}</h3>
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
        <div className="agent-split">
          <section className="agent-primary">
            <div className="agent-section-head">
              <h3>{t("agent.contextExposed")}</h3>
              {selected && (
                <span className="muted">
                  {selected.tool} · {selected.ts}
                </span>
              )}
            </div>
            {selected ? (
              <div className="context-card">
                <p>{t(contextSummaryKey(selected))}</p>
                <div className="context-grid">
                  {payloadRows(selected.payload).map(([key, value]) => (
                    <div className="context-row" key={key}>
                      <span>{key}</span>
                      <code>{displayValue(value)}</code>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="muted">{t("agent.noSelection")}</p>
            )}
          </section>
          <aside className="agent-secondary">
            <h3>{t("agent.timeline")}</h3>
            <Timeline
              feed={feed}
              selected={selected}
              onSelect={selectItem}
            />
          </aside>
        </div>
      ) : (
        <div className="agent-audit-grid ds-card-grid">
          <section
            className="agent-policy-card ds-card ds-card-row ds-tone-trust"
            title={t("agent.auditReadOnlyBody")}
          >
            <Icon name="database" />
            <div>
              <strong>{t("agent.auditReadOnly")}</strong>
              <InfoTip label={t("agent.auditReadOnlyBody")} />
            </div>
          </section>
          <section
            className="agent-policy-card ds-card ds-card-row ds-tone-danger"
            title={t("agent.auditBlockedWritesBody")}
          >
            <Icon name="circleSlash" />
            <div>
              <strong>{t("agent.auditBlockedWrites")}</strong>
              <InfoTip label={t("agent.auditBlockedWritesBody")} />
            </div>
          </section>
          <section
            className="agent-policy-card ds-card ds-card-row"
            title={t("agent.auditHashChainBody")}
          >
            <Icon name="check" />
            <div>
              <strong>{t("agent.auditHashChain")}</strong>
              <InfoTip label={t("agent.auditHashChainBody")} />
            </div>
          </section>
          <section className="agent-policy-card wide ds-panel">
            <div className="agent-section-head">
              <h3>{t("agent.policy")}</h3>
              <span
                className={`badge status ${
                  errorItems.length ? "status-error" : "status-ok"
                } icon-only-badge`}
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
