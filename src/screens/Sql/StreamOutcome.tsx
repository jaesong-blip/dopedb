// Bounded desktop stream projection. The grid and exports consume the immutable
// chunk source directly; this component never flattens a partial result.
import { useMemo, useState } from "react";

import {
  iterateSqlStreamRows,
  type SqlStreamViewState,
} from "../../features/queries/domain";
import DataGrid from "../../components/DataGrid";
import {
  ResultWorkbenchFooter,
  ResultWorkbenchToolbar,
  resultCellText,
} from "../../components/ResultWorkbench";
import {
  ResultMeta,
  SqlSnippet,
} from "../../design-system/components/Workbench";
import type { JsonValue } from "../../ipc/types";
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
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const filteredRows = useMemo<JsonValue[][] | null>(() => {
    if (partial || !normalizedFilter) return null;
    const rows: JsonValue[][] = [];
    for (const row of iterateSqlStreamRows(stream.rowSource)) {
      if (
        row.some((value) =>
          resultCellText(value)
            .toLocaleLowerCase()
            .includes(normalizedFilter),
        )
      ) {
        rows.push([...row] as JsonValue[]);
      }
    }
    return rows;
  }, [normalizedFilter, partial, stream.rowSource]);
  const phaseLabel =
    stream.phase === "cancelled"
      ? t("sql.cancelled")
      : stream.phase === "outcome_unknown"
        ? t("common.unknown")
        : stream.phase === "error"
          ? (stream.error ?? t("sql.errorTitle"))
          : t("sql.running");

  return (
    <div
      className="tw:relative tw:flex tw:min-h-0 tw:flex-1 tw:flex-col"
      aria-live="polite"
    >
      {stream.columns.length === 0 ? (
        <ResultMeta>
          <SqlSnippet>{sql}</SqlSnippet>
          {" · "}
          {running ? t("sql.running") : phaseLabel}
        </ResultMeta>
      ) : (
        <>
          <ResultWorkbenchToolbar
            sql={sql}
            columns={stream.columns}
            rows={filteredRows ?? undefined}
            rowSource={filteredRows === null ? stream.rowSource : undefined}
            filenameBase={`query-${stamp()}`}
            partial={partial}
            filterOpen={filterOpen}
            filter={filter}
            filterDisabled={partial}
            onToggleFilter={() => {
              setFilterOpen((open) => !open);
              if (filterOpen) setFilter("");
            }}
            onFilterChange={setFilter}
          />
          <DataGrid
            result={{
              columns: stream.columns,
              rows: filteredRows ?? [],
              rowCount: filteredRows?.length ?? stream.rowCount,
              truncated: stream.truncated,
              durationMs: stream.durationMs ?? 0,
            }}
            rowSource={filteredRows === null ? stream.rowSource : undefined}
            surface="workbench"
          />
          <ResultWorkbenchFooter
            visible={filteredRows?.length ?? stream.rowCount}
            total={stream.rowCount}
            duration={stream.durationMs}
            state={phaseLabel}
            truncated={stream.truncated}
            maxRows={maxRows}
          />
        </>
      )}
    </div>
  );
}
