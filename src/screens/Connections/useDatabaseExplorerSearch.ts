// Owns cross-catalog search result aggregation and keyboard result selection.
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CatalogTreeSearchResult } from "./CatalogTree";

export function useDatabaseExplorerSearch(restoreTreeFocus: () => void) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [resultsByCatalog, setResultsByCatalog] = useState<
    Record<string, CatalogTreeSearchResult[]>
  >({});
  const [activeResultKey, setActiveResultKey] = useState<string | null>(null);

  const onResultsChange = useCallback(
    (catalogKey: string, results: CatalogTreeSearchResult[]) => {
      setResultsByCatalog((current) => {
        if (results.length === 0) {
          if (!(catalogKey in current)) return current;
          const next = { ...current };
          delete next[catalogKey];
          return next;
        }
        if (
          current[catalogKey]?.length === results.length &&
          current[catalogKey]?.every(
            (result, index) => result.key === results[index]?.key,
          )
        ) return current;
        return { ...current, [catalogKey]: results };
      });
    },
    [],
  );
  const results = useMemo(
    () => Object.values(resultsByCatalog).flat(),
    [resultsByCatalog],
  );
  const activeResult = activeResultKey
    ? results.find((result) => result.key === activeResultKey)
    : undefined;

  useEffect(() => {
    if (filter) return;
    setResultsByCatalog({});
    setActiveResultKey(null);
  }, [filter]);

  function move(direction: 1 | -1) {
    if (results.length === 0) return;
    const currentIndex = activeResultKey
      ? results.findIndex((result) => result.key === activeResultKey)
      : -1;
    const nextIndex =
      (currentIndex + direction + results.length) % results.length;
    setActiveResultKey(results[nextIndex]?.key ?? null);
  }

  function close() {
    setFilter("");
    setOpen(false);
    restoreTreeFocus();
  }

  return {
    filter,
    setFilter,
    open,
    openSearch: () => setOpen(true),
    close,
    results,
    activeResult,
    activeResultKey,
    onResultsChange,
    move,
  };
}
