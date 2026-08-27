import { ControlButton, ControlSelect } from "../../app/components/Controls";
import { AnalysisArticleDocument } from "../../app/analyses/[slug]/PublicAnalysisArticle";
import type { PanelTab } from "./domain";
import { bytes, dateTime, StatusPill } from "./presentation";
import type { AnalysisManagementController } from "./useAnalysisManagement";

export function AnalysisManagementView({
  controller,
  canEdit,
}: {
  controller: AnalysisManagementController;
  canEdit: boolean;
}) {
  const {
    text,
    tab,
    setTab,
    articles,
    migrationFailures,
    replacementByFailure,
    setReplacementByFailure,
    selectedId,
    setSelectedId,
    detail,
    loading,
    detailLoading,
    mutating,
    error,
    detailError,
    selected,
    load,
    resolveFailure,
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
              {item === "recovery" && migrationFailures.length > 0 ? (
                <span className="tw:ml-2 tw:rounded-full tw:bg-warning tw:px-1.5 tw:py-0.5 tw:font-mono tw:text-2xs tw:text-foreground">
                  {migrationFailures.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <ControlButton onClick={() => void load()} disabled={loading}>{text.refresh}</ControlButton>
      </div>

      {error ? (
        <p className="tw:m-5 tw:rounded-surface tw:border tw:border-danger/25 tw:bg-danger/5 tw:px-4 tw:py-3 tw:text-xs tw:text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {tab === "library" ? (
        <div className="tw:grid tw:min-h-[560px] tw:grid-cols-[minmax(220px,0.32fr)_minmax(0,1fr)] tw:max-[760px]:grid-cols-1">
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
                        r{article.revision} · {article.connections[0]?.alias ?? "DB"} · {text.manual}
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
              <div className="tw:grid tw:gap-7">
                <header className="tw:flex tw:flex-wrap tw:items-start tw:justify-between tw:gap-3 tw:border-b tw:border-border tw:pb-5">
                  <span className="tw:min-w-0">
                    <h3 className="tw:m-0 tw:text-xl tw:font-medium tw:tracking-tight tw:text-foreground">{selected.definition.title}</h3>
                    <small className="tw:mt-2 tw:block tw:font-mono tw:text-2xs tw:text-muted-foreground">{text.openDesktop}</small>
                  </span>
                  <StatusPill value={selected.state} />
                </header>

                <AnalysisArticleDocument
                  article={{
                    version: 2,
                    title: selected.definition.title,
                    html: selected.definition.html,
                    publishedAt: selected.updatedAt,
                    searchIndexable: false,
                  }}
                  eyebrow={text.articleHtml}
                  resultLabel={text.savedDocument}
                />

                <section className="tw:min-w-0 tw:overflow-hidden tw:rounded-surface tw:border tw:border-border">
                  <h4 className="tw:m-0 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:text-xs tw:font-medium">{text.savedQuery}</h4>
                  <pre className="tw:m-0 tw:max-h-80 tw:overflow-auto tw:bg-surface-inset tw:p-4 tw:font-mono tw:text-2xs tw:leading-body tw:text-foreground"><code>{selected.definition.queries[0]?.sql}</code></pre>
                </section>

                {detailError ? <p className="tw:m-0 tw:text-xs tw:text-danger" role="alert">{detailError}</p> : null}
                {detailLoading ? <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.loading}</p> : null}

                <div className="tw:grid tw:grid-cols-2 tw:gap-5 tw:max-[880px]:grid-cols-1">
                  <section className="tw:min-w-0 tw:rounded-surface tw:border tw:border-border">
                    <h4 className="tw:m-0 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:text-xs tw:font-medium">{text.latestRuns}</h4>
                    {detail.runs.length === 0 ? <p className="tw:m-0 tw:px-4 tw:py-5 tw:text-xs tw:text-muted-foreground">{text.noRuns}</p> : (
                      <ol className="tw:m-0 tw:list-none tw:p-0">
                        {detail.runs.slice(0, 8).map((run) => (
                          <li className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:items-start tw:gap-3 tw:border-b tw:border-border tw:px-4 tw:py-3 tw:last:border-b-0" key={run.id}>
                            <StatusPill value={run.state} />
                            <span className="tw:min-w-0 tw:text-2xs tw:text-muted-foreground">
                              <strong className="tw:block tw:truncate tw:font-medium tw:text-foreground">r{run.articleRevision} · {run.rowCount} rows · {bytes(run.byteCount)}</strong>
                              <time>{dateTime(run.finishedAt ?? run.createdAt, text.never)}</time>
                              {run.errorKind ? <small className="tw:mt-1 tw:block tw:truncate tw:text-danger">{run.errorKind}: {run.errorMessage}</small> : null}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>

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
                              <a className="tw:text-xs tw:font-medium tw:text-primary tw:hover:underline" href={`/analyses/${encodeURIComponent(publication.slug)}`} target="_blank" rel="noreferrer">{text.openPublication}</a>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {tab === "recovery" && canEdit ? (
        <section className="tw:grid tw:gap-5 tw:p-6 tw:max-[560px]:p-4">
          <p className="tw:m-0 tw:max-w-3xl tw:text-xs tw:leading-body tw:text-muted-foreground">{text.recoveryDescription}</p>
          {migrationFailures.length === 0 ? (
            <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{text.recoveryEmpty}</p>
          ) : (
            <ol className="tw:m-0 tw:grid tw:list-none tw:gap-4 tw:p-0">
              {migrationFailures.map((failure) => (
                <li className="tw:grid tw:gap-4 tw:rounded-surface tw:border tw:border-warning/35 tw:bg-warning/5 tw:p-4" key={failure.id}>
                  <span className="tw:min-w-0">
                    <strong className="tw:block tw:truncate tw:text-sm tw:font-medium">{failure.title}</strong>
                    <small className="tw:mt-1 tw:block tw:font-mono tw:text-2xs tw:text-muted-foreground">{failure.sourceKind.replaceAll("_", " ")} · r{failure.sourceRevision}</small>
                  </span>
                  <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-foreground">{failure.failureReason}</p>
                  <details className="tw:min-w-0 tw:rounded-control tw:border tw:border-border tw:bg-surface">
                    <summary className="tw:cursor-pointer tw:px-3 tw:py-2 tw:text-xs tw:font-medium tw:text-muted-foreground">{text.original}</summary>
                    <pre className="tw:m-0 tw:max-h-80 tw:overflow-auto tw:border-t tw:border-border tw:p-3 tw:font-mono tw:text-2xs tw:leading-body tw:text-muted-foreground">{JSON.stringify(failure.payload, null, 2)}</pre>
                  </details>
                  <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-end tw:gap-3 tw:max-[620px]:grid-cols-1">
                    <label className="tw:grid tw:gap-2">
                      <span className="tw:font-mono tw:text-2xs tw:font-medium tw:uppercase tw:text-muted-foreground">{text.replacement}</span>
                      <ControlSelect value={replacementByFailure[failure.id] ?? ""} onChange={(event) => setReplacementByFailure((current) => ({ ...current, [failure.id]: event.target.value }))}>
                        <option value="">{text.chooseReplacement}</option>
                        {articles.map((article) => <option value={article.id} key={article.id}>{article.definition.title} · r{article.revision}</option>)}
                      </ControlSelect>
                    </label>
                    <ControlButton disabled={!replacementByFailure[failure.id] || mutating} onClick={() => void resolveFailure(failure.id)}>
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
