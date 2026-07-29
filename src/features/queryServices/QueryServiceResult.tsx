import { useMemo, useState } from "react";

import DataGrid from "../../components/DataGrid";
import ResultToolbar from "../../components/ResultToolbar";
import {
  ResultWorkbenchFooter,
  ResultWorkbenchToolbar,
  resultCellText,
} from "../../components/ResultWorkbench";
import {
  ResultMeta,
  SqlSnippet,
  WorkbenchEmptyState,
} from "../../design-system/components/Workbench";
import { Icon } from "../../components/Icon";
import { stamp } from "../../lib/export";
import { useI18n } from "../../lib/i18n";
import StreamOutcome from "../../screens/Sql/StreamOutcome";
import type {
  QueryServiceError,
  QueryServiceResult as QueryServiceResultModel,
} from "./domain";

const PAGE_STEP = 200;

export default function QueryServiceResult({
  result,
}: {
  result: QueryServiceResultModel;
}) {
  if (result.kind === "none") {
    return (
      <WorkbenchEmptyState icon="table">
        <EmptyResultMessage />
      </WorkbenchEmptyState>
    );
  }
  if (result.kind === "materialized") {
    return (
      <MaterializedResult
        sql={result.sql}
        outcome={result.outcome}
        at={result.at}
        maxRows={result.maxRows}
      />
    );
  }
  if (result.kind === "stream") {
    return (
      <StreamOutcome
        stream={result.stream}
        sql={result.sql}
        maxRows={result.maxRows}
      />
    );
  }
  if (result.kind === "script") {
    return <ScriptResults outcome={result.outcome} at={result.at} />;
  }
  return <SqlErrorCard error={result.error} prompt={result.prompt} />;
}

function EmptyResultMessage() {
  const { t } = useI18n();
  return <>{t("sql.resultsEmpty")}</>;
}

function MaterializedResult({
  sql,
  outcome,
  at,
  maxRows,
}: Omit<
  Extract<QueryServiceResultModel, { kind: "materialized" }>,
  "kind"
>) {
  const { t } = useI18n();
  const [limit, setLimit] = useState(PAGE_STEP);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const result = outcome.result;
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const filteredRows = useMemo(() => {
    if (!result || !normalizedFilter) return result?.rows ?? [];
    return result.rows.filter((row) =>
      row.some((value) =>
        resultCellText(value).toLocaleLowerCase().includes(normalizedFilter),
      ),
    );
  }, [normalizedFilter, result]);
  const visibleRows = filteredRows.slice(0, limit);

  return (
    <div className="tw:relative tw:flex tw:min-h-0 tw:flex-1 tw:flex-col">
      {result ? (
        <>
          <ResultWorkbenchToolbar
            columns={result.columns}
            rows={filteredRows}
            filenameBase={`query-${stamp()}`}
            filterOpen={filterOpen}
            filter={filter}
            onToggleFilter={() => {
              setFilterOpen((open) => !open);
              if (filterOpen) setFilter("");
            }}
            onFilterChange={(value) => {
              setFilter(value);
              setLimit(PAGE_STEP);
            }}
          />
          <DataGrid
            result={{
              ...result,
              rows: visibleRows,
              rowCount: filteredRows.length,
            }}
            surface="workbench"
          />
          <ResultWorkbenchFooter
            visible={visibleRows.length}
            total={result.rows.length}
            duration={result.durationMs}
            truncated={result.truncated}
            maxRows={maxRows}
            showMoreCount={Math.min(
              PAGE_STEP,
              filteredRows.length - visibleRows.length,
            )}
            onShowMore={
              filteredRows.length > limit
                ? () => setLimit((current) => current + PAGE_STEP)
                : undefined
            }
          />
        </>
      ) : (
        <ResultMeta>
          <SqlSnippet>{sql}</SqlSnippet>
          {" · "}
          {outcome.committed
            ? t("sql.writeCommitted")
            : t("sql.noRowsReturned")}
          {outcome.affected !== null && (
            <> · {t("sql.affected", { count: outcome.affected })}</>
          )}{" "}
          · {at}
        </ResultMeta>
      )}
    </div>
  );
}

function ScriptResults({
  outcome,
  at,
}: Omit<Extract<QueryServiceResultModel, { kind: "script" }>, "kind">) {
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
      {outcome.statements.map((statement, index) => (
        <section
          key={`${index}:${statement.sql}`}
          className="tw:border-t tw:border-border-subtle tw:pt-2"
        >
          <ResultMeta>
            <span className="tw:inline-block tw:min-w-4 tw:font-semibold">
              {index + 1}
            </span>
            <SqlSnippet>{statement.sql}</SqlSnippet>
          </ResultMeta>
          {statement.error ? (
            <div className="tw:px-3 tw:py-2 tw:text-ui tw:text-danger">
              {statement.error}
            </div>
          ) : statement.result ? (
            <>
              <div className="tw:mx-3 tw:my-1 tw:text-sm tw:text-muted-foreground">
                {t(
                  statement.result.truncated
                    ? "agent.rowsTruncated"
                    : "agent.rows",
                  { count: statement.result.rowCount },
                )}{" "}
                · {statement.result.durationMs} ms
                {" · "}
                <ResultToolbar
                  columns={statement.result.columns}
                  rows={statement.result.rows}
                  filenameBase={`script-stmt${index + 1}-${stamp()}`}
                />
              </div>
              <DataGrid result={statement.result} surface="workbench" />
            </>
          ) : (
            <div className="tw:px-3 tw:py-2 tw:text-sm tw:text-muted-foreground">
              {t("sql.affected", { count: statement.affected ?? 0 })}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function errorPosition(sql: string, position: number) {
  const codePoints = Array.from(sql);
  const index = Math.min(Math.max(position - 1, 0), codePoints.length);
  const lineStart =
    index === 0 ? 0 : codePoints.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = codePoints.indexOf("\n", index);
  const column = index - lineStart;
  return {
    line: codePoints.slice(0, index).filter((value) => value === "\n").length + 1,
    column: column + 1,
    snippet:
      codePoints
        .slice(lineStart, lineEnd === -1 ? codePoints.length : lineEnd)
        .join("") +
      "\n" +
      " ".repeat(column) +
      "^",
  };
}

function SqlErrorCard({
  error,
  prompt,
}: {
  error: QueryServiceError;
  prompt: string;
}) {
  const { t } = useI18n();
  const position =
    error.position !== null ? errorPosition(error.sql, error.position) : null;
  return (
    <div
      className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:overflow-auto tw:text-foreground"
      role="alert"
    >
      <ResultMeta>
        <Icon name="alert" className="tw:text-danger" />
        <strong className="tw:text-danger">{t("sql.errorTitle")}</strong>
        <span className="tw:text-muted-foreground"> · {error.at}</span>
      </ResultMeta>
      <dl className="tw:m-0 tw:grid tw:grid-cols-[max-content_minmax(0,1fr)] tw:items-stretch tw:[&>*]:m-0 tw:[&>*]:border-b tw:[&>*]:border-border-subtle tw:[&>*]:px-3 tw:[&>*]:py-2 tw:[&>dd]:min-w-0 tw:[&>dt]:text-muted-foreground tw:max-[760px]:grid-cols-1 tw:max-[760px]:[&>dt]:border-b-0 tw:max-[760px]:[&>dt]:pb-0">
        <dt>{t("sql.errorKind")}</dt>
        <dd>
          <code className="tw:font-mono tw:text-sm">
            {error.kind ?? t("common.unknown")}
          </code>
        </dd>
        <dt>{t("sql.errorMessage")}</dt>
        <dd>
          <pre className="tw:m-0 tw:overflow-auto tw:font-mono tw:text-sm tw:whitespace-pre-wrap tw:[overflow-wrap:anywhere]">
            {error.message}
          </pre>
        </dd>
        {position ? (
          <>
            <dt>{t("sql.errorPosition")}</dt>
            <dd>
              <pre className="tw:m-0 tw:overflow-auto tw:font-mono tw:text-sm tw:whitespace-pre-wrap tw:[overflow-wrap:anywhere]">
                {t("sql.errorPositionAt", {
                  line: position.line,
                  column: position.column,
                })}
                {"\n"}
                {position.snippet}
              </pre>
            </dd>
          </>
        ) : null}
      </dl>
      <details className="tw:border-b tw:border-border-subtle">
        <summary className="tw:min-h-control-md tw:cursor-pointer tw:px-3 tw:py-2 tw:text-ui tw:text-muted-foreground">
          {t("sql.errorContext")}
        </summary>
        <pre className="tw:m-0 tw:max-h-[280px] tw:overflow-auto tw:border-t tw:border-border-subtle tw:bg-background tw:p-3 tw:font-mono tw:text-sm tw:whitespace-pre-wrap tw:[overflow-wrap:anywhere]">
          {prompt}
        </pre>
      </details>
    </div>
  );
}
