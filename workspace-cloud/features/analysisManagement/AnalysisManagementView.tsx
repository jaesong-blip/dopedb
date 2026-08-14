// The feature view owns Analysis management JSX while the controller owns every mutation.
import { ControlButton, ControlSelect } from "../../app/components/Controls";
import { AnalysisArticleDocument } from "../../app/analyses/[slug]/PublicAnalysisArticle";
import type { PanelTab } from "./domain";
import { bytes, dateTime, StatusPill } from "./presentation";
import type { AnalysisManagementController } from "./useAnalysisManagement";

export function AnalysisManagementView({
  controller,
  initialArticleId,
  initialBlockId,
  canEdit,
}: {
  controller: AnalysisManagementController;
  initialArticleId: string | null;
  initialBlockId: string | null;
  canEdit: boolean;
}) {
  const {
    text,
    tab,
    setTab,
    articles,
    runners,
    notifications,
    migrationFailures,
    replacementByFailure,
    setReplacementByFailure,
    selectedId,
    setSelectedId,
    detail,
    selectedNotifications,
    setSelectedNotifications,
    loading,
    detailLoading,
    resultRunId,
    setResultRunId,
    resultLoading,
    resultError,
    mutating,
    error,
    detailError,
    selected,
    unreadCount,
    compatibleRuns,
    resultDocument,
    load,
    markSelectedRead,
    resolveFailure,
    selectNotification,
  } = controller;

  return (
    <div className="tw:min-w-0">
      <div className="tw:flex tw:min-h-12 tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:px-5">
        <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-1" role="tablist" aria-label="Analysis management">
          {(Object.keys(text.tabs) as PanelTab[]).filter((item) => item !== "recovery" || canEdit).map((item) => (
            <button
              className="tw:relative tw:h-12 tw:border-0 tw:bg-transparent tw:px-3 tw:text-xs tw:font-medium tw:text-muted-foreground tw:after:absolute tw:after:inset-x-3 tw:after:bottom-0 tw:after:h-0.5 tw:after:scale-x-0 tw:after:bg-primary tw:after:transition-transform tw:hover:text-foreground tw:data-[active=true]:text-foreground tw:data-[active=true]:after:scale-x-100"
              data-active={tab === item}
              key={item}
              onClick={() => setTab(item)}
              role="tab"
              type="button"
              aria-selected={tab === item}
            >
              {text.tabs[item]}
              {item === "inbox" && unreadCount > 0 ? (
                <span className="tw:ml-2 tw:rounded-full tw:bg-danger tw:px-1.5 tw:py-0.5 tw:font-mono tw:text-2xs tw:text-primary-foreground">
                  {unreadCount}
                </span>
              ) : null}
              {item === "recovery" && migrationFailures.length > 0 ? (
                <span className="tw:ml-2 tw:rounded-full tw:bg-warning tw:px-1.5 tw:py-0.5 tw:font-mono tw:text-2xs tw:text-foreground">
                  {migrationFailures.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <ControlButton onClick={() => void load()} disabled={loading}>
          {text.refresh}
        </ControlButton>
      </div>

      {error ? (
        <p className="tw:m-5 tw:rounded-surface tw:border tw:border-danger/25 tw:bg-danger/5 tw:px-4 tw:py-3 tw:text-xs tw:text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {tab === "library" ? (
        <div className="tw:grid tw:min-h-[560px] tw:grid-cols-[minmax(220px,0.38fr)_minmax(0,1fr)] tw:max-[760px]:grid-cols-1">
          <aside className="tw:min-w-0 tw:border-r tw:border-border tw:bg-surface-inset/45 tw:max-[760px]:max-h-64 tw:max-[760px]:overflow-auto tw:max-[760px]:border-r-0 tw:max-[760px]:border-b">
            {loading ? <p className="tw:m-0 tw:px-5 tw:py-8 tw:text-xs tw:text-muted-foreground">{text.loading}</p> : null}
            {!loading && articles.length === 0 ? <p className="tw:m-0 tw:px-5 tw:py-8 tw:text-xs tw:leading-body tw:text-muted-foreground">{text.empty}</p> : null}
            <ol className="tw:m-0 tw:list-none tw:p-0">
              {articles.map((article) => (
                <li className="tw:border-b tw:border-border" key={article.id}>
                  <button
                    className="tw:grid tw:w-full tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto] tw:gap-3 tw:border-0 tw:bg-transparent tw:px-5 tw:py-4 tw:text-left tw:hover:bg-surface-raised tw:data-[active=true]:bg-selection"
                    data-active={article.id === selectedId}
                    onClick={() => setSelectedId(article.id)}
                    type="button"
                  >
                    <span className="tw:min-w-0">
                      <strong className="tw:block tw:truncate tw:text-xs tw:font-medium tw:text-foreground">{article.definition.title}</strong>
                      <small className="tw:mt-1 tw:block tw:truncate tw:font-mono tw:text-2xs tw:text-muted-foreground">
                        r{article.revision} · {article.connections.length} DB · {article.definition.blocks.length} blocks
                      </small>
                    </span>
                    <StatusPill value={article.state} />
                  </button>
                </li>
              ))}
            </ol>
          </aside>

          <section className="tw:min-w-0 tw:p-6 tw:max-[560px]:p-4" aria-live="polite">
            {!selected ? <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.select}</p> : (
              <div className="tw:grid tw:gap-6">
                <header className="tw:grid tw:gap-2 tw:border-b tw:border-border tw:pb-5">
                  <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3">
                    <h3 className="tw:m-0 tw:text-xl tw:font-medium tw:tracking-tight tw:text-foreground">{selected.definition.title}</h3>
                    <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                      <StatusPill value={selected.state} />
                      {selected.liveRevision ? <StatusPill value="live" label={`${text.live} r${selected.liveRevision}`} /> : null}
                    </div>
                  </div>
                  <p className="tw:m-0 tw:max-w-3xl tw:text-xs tw:leading-body tw:text-muted-foreground">{selected.definition.summary || selected.definition.question}</p>
                  <p className="tw:m-0 tw:font-mono tw:text-2xs tw:text-muted-foreground">{text.openDesktop}</p>
                </header>

                <dl className="tw:grid tw:grid-cols-3 tw:gap-px tw:overflow-hidden tw:rounded-surface tw:border tw:border-border tw:bg-border tw:max-[760px]:grid-cols-1">
                  <div className="tw:grid tw:gap-1 tw:bg-surface tw:p-4"><dt className="tw:font-mono tw:text-2xs tw:text-muted-foreground">{text.articleMeta}</dt><dd className="tw:m-0 tw:text-xs tw:text-foreground">{text.working} r{selected.revision} · {selected.definition.blocks.length} blocks</dd></div>
                  <div className="tw:grid tw:gap-1 tw:bg-surface tw:p-4"><dt className="tw:font-mono tw:text-2xs tw:text-muted-foreground">{text.sourceScope}</dt><dd className="tw:m-0 tw:text-xs tw:text-foreground">Environment r{selected.environmentRevision} · {selected.connections.length} DB · {selected.definition.queries.length} queries</dd></div>
                  <div className="tw:grid tw:gap-1 tw:bg-surface tw:p-4"><dt className="tw:font-mono tw:text-2xs tw:text-muted-foreground">{text.freshness}</dt><dd className="tw:m-0 tw:text-xs tw:text-foreground">{selected.definition.refresh.mode === "scheduled" ? text.scheduled : text.manual} · {text.next} {dateTime(selected.nextRefreshAt, text.never)}</dd></div>
                </dl>

                {initialBlockId && selected.id === initialArticleId ? (
                  <p className="tw:m-0 tw:rounded-surface tw:border tw:border-primary/20 tw:bg-selection tw:px-4 tw:py-3 tw:font-mono tw:text-2xs tw:text-primary">
                    {text.block}: {initialBlockId}
                  </p>
                ) : null}
                {detailError ? <p className="tw:m-0 tw:text-xs tw:text-danger" role="alert">{detailError}</p> : null}
                {detailLoading ? <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.loading}</p> : null}

                <section className="tw:min-w-0 tw:overflow-hidden tw:rounded-surface tw:border tw:border-border">
                  <header className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:px-4 tw:py-3">
                    <h4 className="tw:m-0 tw:text-xs tw:font-medium">{text.articleResult}</h4>
                    {compatibleRuns.length > 0 ? (
                      <label className="tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-2xs tw:text-muted-foreground">
                        {text.resultRevision}
                        <ControlSelect
                          value={resultRunId}
                          onChange={(event) => setResultRunId(event.target.value)}
                        >
                          {compatibleRuns.map((run) => (
                            <option value={run.id} key={run.id}>
                              r{run.articleRevision} · {dateTime(run.finishedAt, text.never)}
                            </option>
                          ))}
                        </ControlSelect>
                      </label>
                    ) : null}
                  </header>
                  <div className="tw:min-w-0 tw:bg-surface-inset/20 tw:p-6 tw:max-[560px]:p-4">
                    {resultLoading ? <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.loading}</p> : null}
                    {resultError ? <p className="tw:m-0 tw:text-xs tw:text-danger" role="alert">{resultError}</p> : null}
                    {!resultLoading && !resultError && compatibleRuns.length === 0 ? (
                      <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">{text.noCompatibleResult}</p>
                    ) : null}
                    {!resultLoading && !resultError && resultDocument ? (
                      <AnalysisArticleDocument
                        article={resultDocument}
                        eyebrow={text.articleResult}
                        resultLabel={text.resultAsOf}
                      />
                    ) : null}
                  </div>
                </section>

                <div className="tw:grid tw:grid-cols-2 tw:gap-5 tw:max-[880px]:grid-cols-1">
                  <section className="tw:min-w-0 tw:rounded-surface tw:border tw:border-border">
                    <h4 className="tw:m-0 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:text-xs tw:font-medium">{text.latestRuns}</h4>
                    {detail.runs.length === 0 ? <p className="tw:m-0 tw:px-4 tw:py-5 tw:text-xs tw:text-muted-foreground">{text.noRuns}</p> : (
                      <ol className="tw:m-0 tw:list-none tw:p-0">
                        {detail.runs.slice(0, 8).map((run) => (
                          <li className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:items-start tw:gap-3 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:last:border-b-0" key={run.id}>
                            <StatusPill value={run.state} />
                            <span className="tw:min-w-0 tw:text-2xs tw:text-muted-foreground">
                              <strong className="tw:block tw:truncate tw:font-medium tw:text-foreground">r{run.articleRevision} · {run.trigger} · {run.rowCount} rows · {bytes(run.byteCount)}</strong>
                              <time>{dateTime(run.finishedAt ?? run.createdAt, text.never)}</time>
                              {run.errorKind ? <small className="tw:mt-1 tw:block tw:truncate tw:text-danger">{run.errorKind}: {run.errorMessage}</small> : null}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>

                  <section className="tw:min-w-0 tw:rounded-surface tw:border tw:border-border">
                    <h4 className="tw:m-0 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:text-xs tw:font-medium">{text.signals}</h4>
                    {detail.signals.length === 0 ? <p className="tw:m-0 tw:px-4 tw:py-5 tw:text-xs tw:text-muted-foreground">{text.noSignals}</p> : (
                      <ol className="tw:m-0 tw:list-none tw:p-0">
                        {detail.signals.map((signal) => (
                          <li className="tw:flex tw:items-start tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:last:border-b-0" key={signal.id}>
                            <span className="tw:min-w-0 tw:text-2xs tw:text-muted-foreground">
                              <strong className="tw:block tw:truncate tw:font-medium tw:text-foreground">{signal.blockId} · r{signal.revision}</strong>
                              {signal.definition.channels.join(" · ")}
                            </span>
                            <StatusPill value={signal.enabled ? signal.lastObservedState : "disabled"} label={signal.enabled ? signal.lastObservedState : "disabled"} />
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                </div>

                <section className="tw:min-w-0 tw:rounded-surface tw:border tw:border-border">
                  <h4 className="tw:m-0 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:text-xs tw:font-medium">{text.publications}</h4>
                  {detail.publications.length === 0 ? <p className="tw:m-0 tw:px-4 tw:py-5 tw:text-xs tw:text-muted-foreground">{text.noPublications}</p> : (
                    <ol className="tw:m-0 tw:list-none tw:p-0">
                      {detail.publications.map((publication) => (
                        <li className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:last:border-b-0" key={publication.id}>
                          <span className="tw:min-w-0">
                            <strong className="tw:block tw:truncate tw:text-xs tw:font-medium">{publication.title}</strong>
                            <small className="tw:font-mono tw:text-2xs tw:text-muted-foreground">v{publication.version} · {publication.visibility} · {dateTime(publication.publishedAt, text.never)}</small>
                          </span>
                          {publication.revokedAt ? <StatusPill value="revoked" label={text.revoked} /> : (
                            <a className="tw:text-xs tw:font-medium tw:text-primary tw:hover:underline" href={`/analyses/${encodeURIComponent(publication.slug)}`} target="_blank" rel="noreferrer">
                              {text.openPublication}
                            </a>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {tab === "inbox" ? (
        <section className="tw:p-6 tw:max-[560px]:p-4">
          <div className="tw:mb-4 tw:flex tw:justify-end">
            <ControlButton disabled={selectedNotifications.size === 0 || mutating} onClick={() => void markSelectedRead()}>
              {text.markRead}
            </ControlButton>
          </div>
          {notifications.length === 0 ? <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.inboxEmpty}</p> : (
            <ol className="tw:m-0 tw:list-none tw:overflow-hidden tw:rounded-surface tw:border tw:border-border tw:p-0">
              {notifications.map((notification) => (
                <li className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-center tw:gap-4 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:last:border-b-0 tw:max-[620px]:grid-cols-[auto_minmax(0,1fr)]" key={notification.id}>
                  <input
                    aria-label={`${notification.articleTitle} ${notification.state}`}
                    checked={selectedNotifications.has(notification.id)}
                    disabled={Boolean(notification.readAt)}
                    onChange={(event) => setSelectedNotifications((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(notification.id);
                      else next.delete(notification.id);
                      return next;
                    })}
                    type="checkbox"
                  />
                  <button className="tw:min-w-0 tw:border-0 tw:bg-transparent tw:text-left" onClick={() => selectNotification(notification)} type="button">
                    <strong className="tw:block tw:truncate tw:text-xs tw:font-medium tw:text-foreground">{notification.articleTitle}</strong>
                    <small className="tw:mt-1 tw:block tw:truncate tw:font-mono tw:text-2xs tw:text-muted-foreground">{notification.blockId} · signal r{notification.signalRevision} · {dateTime(notification.evaluatedAt, text.never)}</small>
                  </button>
                  <div className="tw:flex tw:items-center tw:gap-2 tw:max-[620px]:col-start-2">
                    <StatusPill value={notification.state} />
                    <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground">{notification.readAt ? text.read : text.unread}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      {tab === "runners" ? (
        <section className="tw:p-6 tw:max-[560px]:p-4">
          {runners.length === 0 ? <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">{text.runnersEmpty}</p> : (
            <ol className="tw:m-0 tw:grid tw:list-none tw:grid-cols-2 tw:gap-4 tw:p-0 tw:max-[760px]:grid-cols-1">
              {runners.map((runner) => (
                <li className="tw:grid tw:gap-4 tw:rounded-surface tw:border tw:border-border tw:bg-surface-inset/40 tw:p-4" key={runner.id}>
                  <div className="tw:flex tw:items-start tw:justify-between tw:gap-3">
                    <span className="tw:min-w-0">
                      <strong className="tw:block tw:truncate tw:text-xs tw:font-medium">{runner.displayName}</strong>
                      <small className="tw:mt-1 tw:block tw:font-mono tw:text-2xs tw:text-muted-foreground">{runner.backgroundAllowed ? text.background : text.foreground}</small>
                    </span>
                    <StatusPill value={runner.online ? "online" : "offline"} label={runner.online ? text.online : text.offline} />
                  </div>
                  <dl className="tw:m-0 tw:grid tw:grid-cols-2 tw:gap-3 tw:text-2xs">
                    <div><dt className="tw:text-muted-foreground">{text.lastSeen}</dt><dd className="tw:m-0 tw:mt-1 tw:text-foreground">{dateTime(runner.lastSeenAt, text.never)}</dd></div>
                    <div><dt className="tw:text-muted-foreground">Schedule</dt><dd className="tw:m-0 tw:mt-1 tw:text-foreground">{runner.scheduledArticleCount} {text.schedules}</dd></div>
                  </dl>
                  <p className="tw:m-0 tw:text-2xs tw:text-muted-foreground">{runner.online && runner.backgroundAllowed ? text.healthy : text.unavailable}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      {tab === "recovery" && canEdit ? (
        <section className="tw:grid tw:gap-5 tw:p-6 tw:max-[560px]:p-4">
          <p className="tw:m-0 tw:max-w-3xl tw:text-xs tw:leading-body tw:text-muted-foreground">
            {text.recoveryDescription}
          </p>
          {migrationFailures.length === 0 ? (
            <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.recoveryEmpty}</p>
          ) : (
            <ol className="tw:m-0 tw:grid tw:list-none tw:gap-4 tw:p-0">
              {migrationFailures.map((failure) => (
                <li className="tw:grid tw:gap-4 tw:rounded-surface tw:border tw:border-warning/35 tw:bg-warning/5 tw:p-4" key={failure.id}>
                  <div className="tw:flex tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
                    <span className="tw:min-w-0">
                      <strong className="tw:block tw:truncate tw:text-sm tw:font-medium">{failure.title}</strong>
                      <small className="tw:mt-1 tw:block tw:font-mono tw:text-2xs tw:text-muted-foreground">
                        {failure.sourceKind.replaceAll("_", " ")} · r{failure.sourceRevision} · {failure.sourceId}
                      </small>
                    </span>
                    <StatusPill value="stale" label={failure.sourceKind.replaceAll("_", " ")} />
                  </div>
                  <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-foreground">{failure.failureReason}</p>
                  <details className="tw:min-w-0 tw:rounded-control tw:border tw:border-border tw:bg-surface">
                    <summary className="tw:cursor-pointer tw:px-3 tw:py-2 tw:text-xs tw:font-medium tw:text-muted-foreground">{text.original}</summary>
                    <pre className="tw:m-0 tw:max-h-80 tw:overflow-auto tw:border-t tw:border-border tw:p-3 tw:font-mono tw:text-2xs tw:leading-body tw:text-muted-foreground">{JSON.stringify(failure.payload, null, 2)}</pre>
                  </details>
                  <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-end tw:gap-3 tw:max-[620px]:grid-cols-1">
                    <label className="tw:grid tw:gap-2">
                      <span className="tw:font-mono tw:text-2xs tw:font-medium tw:uppercase tw:text-muted-foreground">{text.replacement}</span>
                      <ControlSelect
                        value={replacementByFailure[failure.id] ?? ""}
                        onChange={(event) => setReplacementByFailure((current) => ({
                          ...current,
                          [failure.id]: event.target.value,
                        }))}
                      >
                        <option value="">{text.chooseReplacement}</option>
                        {articles.map((article) => (
                          <option value={article.id} key={article.id}>{article.definition.title} · r{article.revision} · {article.state}</option>
                        ))}
                      </ControlSelect>
                    </label>
                    <ControlButton
                      disabled={!replacementByFailure[failure.id] || mutating}
                      onClick={() => void resolveFailure(failure.id)}
                    >
                      {mutating ? text.resolving : text.resolve}
                    </ControlButton>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}
