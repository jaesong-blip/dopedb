// Bounded desktop stream projection. The grid and exports consume the immutable
// chunk source directly; this component never flattens a partial result.
import type { SqlStreamViewState } from "../../features/queries/domain";
import DataGrid from "../../components/DataGrid";
import ResultToolbar from "../../components/ResultToolbar";
import {
  ResultMeta,
  SqlSnippet,
} from "../../design-system/components/Workbench";
import { stamp } from "../../lib/export";
import { useI18n } from "../../lib/i18n";

export default function StreamOutcome({
  stream,
  sql,
  maxRows,
}: {
  stream: SqlStreamViewState;
  sql: string;
  maxRows: number;
}) {
  const { t } = useI18n();
  const running =
    stream.phase === "connecting" || stream.phase === "streaming";
  const partial = stream.phase !== "complete";
  return (
    <div
      className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col"
      aria-live="polite"
    >
      <ResultMeta>
        <SqlSnippet>{sql}</SqlSnippet>
        {" · "}
        {running
          ? t("sql.running")
          : stream.phase === "cancelled"
            ? t("sql.cancelled")
            : stream.phase === "outcome_unknown"
              ? t("common.unknown")
              : stream.phase === "error"
                ? (stream.error ?? t("sql.errorTitle"))
                : t(stream.truncated ? "agent.rowsTruncated" : "agent.rows", {
                    count: stream.rowCount,
                  })}
        {stream.truncated && ` - ${t("sql.capped", { count: maxRows })}`}
        {stream.durationMs !== null && ` · ${stream.durationMs} ms`}
        {stream.columns.length > 0 && (
          <>
            {" · "}
            <ResultToolbar
              columns={stream.columns}
              rowSource={stream.rowSource}
              filenameBase={`query-${stamp()}`}
              partial={partial}
            />
          </>
        )}
      </ResultMeta>
      {stream.columns.length > 0 && (
        <DataGrid
          result={{
            columns: stream.columns,
            rows: [],
            rowCount: stream.rowCount,
            truncated: stream.truncated,
            durationMs: stream.durationMs ?? 0,
          }}
          rowSource={stream.rowSource}
          surface="workbench"
        />
      )}
    </div>
  );
}
