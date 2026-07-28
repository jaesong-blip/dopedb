import { useState } from "react";

import DataGrid from "../../components/DataGrid";
import ResultToolbar from "../../components/ResultToolbar";
import {
  ResultMeta,
  SqlSnippet,
  WorkbenchEmptyState,
} from "../../design-system/components/Workbench";
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
  const result = outcome.result;

  return (
    <div className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col">
      <ResultMeta>
        <SqlSnippet>{sql}</SqlSnippet>
        {result ? (
          <>
            {" · "}
            {t(result.truncated ? "agent.rowsTruncated" : "agent.rows", {
              count: result.rowCount,
            })}
            {result.truncated &&
              ` - ${t("sql.capped", { count: maxRows })}`}{" "}
            · {result.durationMs} ms · {at}
            {" · "}
            <ResultToolbar
              columns={result.columns}
              rows={result.rows}
              filenameBase={`query-${stamp()}`}
            />
          </>
        ) : (
          <>
            {" · "}
            {outcome.committed
              ? t("sql.writeCommitted")
              : t("sql.noRowsReturned")}
            {outcome.affected !== null && (
              <> · {t("sql.affected", { count: outcome.affected })}</>
            )}{" "}
            · {at}
          </>
        )}
      </ResultMeta>
      {result && (
        <>
          <DataGrid
            result={
              limit < result.rows.length
                ? { ...result, rows: result.rows.slice(0, limit) }
                : result
            }
            surface="workbench"
          />
          {result.rows.length > limit && (
            <button
              className="btn tw:m-3 tw:self-start"
              onClick={() => setLimit((current) => current + PAGE_STEP)}
            >
              {t("sql.showMore", {
                count: Math.min(PAGE_STEP, result.rows.length - limit),
                total: result.rows.length,
              })}
            </button>
          )}
        </>
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
      className="tw:m-3 tw:grid tw:gap-3 tw:rounded-md tw:border tw:border-danger-border tw:bg-danger-muted tw:p-3 tw:text-foreground"
      role="alert"
    >
      <div>
        <strong className="tw:text-danger">{t("sql.errorTitle")}</strong>
        <span className="tw:text-muted-foreground"> · {error.at}</span>
      </div>
      <div className="tw:grid tw:grid-cols-[max-content_minmax(0,1fr)] tw:items-start tw:gap-x-3 tw:gap-y-2 tw:[&_code]:rounded-sm tw:[&_code]:border tw:[&_code]:border-border-subtle tw:[&_code]:bg-card tw:[&_code]:p-2 tw:[&_pre]:m-0 tw:[&_pre]:overflow-auto tw:[&_pre]:rounded-sm tw:[&_pre]:border tw:[&_pre]:border-border-subtle tw:[&_pre]:bg-card tw:[&_pre]:p-2 tw:[&_pre]:text-sm tw:[&_pre]:whitespace-pre-wrap tw:[&_pre]:[overflow-wrap:anywhere] tw:max-[760px]:grid-cols-1">
        <span className="tw:text-muted-foreground">{t("sql.errorKind")}</span>
        <code>{error.kind ?? t("common.unknown")}</code>
        <span className="tw:text-muted-foreground">
          {t("sql.errorMessage")}
        </span>
        <pre>{error.message}</pre>
        {position && (
          <>
            <span className="tw:text-muted-foreground">
              {t("sql.errorPosition")}
            </span>
            <pre>
              {t("sql.errorPositionAt", {
                line: position.line,
                column: position.column,
              })}
              {"\n"}
              {position.snippet}
            </pre>
          </>
        )}
      </div>
      <details>
        <summary className="tw:cursor-pointer tw:text-ui tw:text-muted-foreground">
          {t("sql.errorContext")}
        </summary>
        <pre className="tw:mt-2 tw:max-h-[280px] tw:overflow-auto tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:p-2 tw:text-sm tw:whitespace-pre-wrap tw:[overflow-wrap:anywhere]">
          {prompt}
        </pre>
      </details>
    </div>
  );
}
