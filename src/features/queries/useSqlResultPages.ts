import { useEffect, useReducer } from "react";

import type { SqlStreamRowSource } from "./domain";
import {
  ensureSqlResultRange,
  sqlResultPageError,
  subscribeSqlResultPages,
} from "./resultPageCache";
import { readSqlResultPage } from "./tauriAdapter";

export function useSqlResultPages(
  source: SqlStreamRowSource | undefined,
  start: number,
  end: number,
  columns: readonly string[],
) {
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  const sourceKey = source
    ? `${source.operationId ?? ""}:${source.capability ?? ""}`
    : "";

  useEffect(() => {
    if (!source) return;
    return subscribeSqlResultPages(source, refresh);
  }, [source, sourceKey]);

  useEffect(() => {
    if (!source) return;
    void ensureSqlResultRange(source, start, end, columns, readSqlResultPage);
  }, [
    source,
    sourceKey,
    source?.complete,
    source?.rowCount,
    start,
    end,
    columns,
    revision,
  ]);

  return source ? sqlResultPageError(source) : null;
}
