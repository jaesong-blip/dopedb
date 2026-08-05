import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
} from "@tanstack/react-virtual";

const DEFAULT_TREE_ROW_ESTIMATE = 24;
const DEFAULT_OVERSCAN = 8;
const VIRTUAL_TREE_THRESHOLD = 80;

export interface VirtualTreeRow {
  key: string;
  render: () => ReactNode;
}

/**
 * Windowed leaf rows inside the shared Database Explorer scroller. Dynamic
 * metadata rows are measured by React Virtual; a pinned row remains mounted so
 * editor-to-tree reveal can focus it before scrolling.
 */
export function VirtualTreeRows({
  rows,
  scrollElement,
  pinnedKey,
  estimateSize = DEFAULT_TREE_ROW_ESTIMATE,
}: {
  rows: readonly VirtualTreeRow[];
  scrollElement: HTMLDivElement | null;
  pinnedKey?: string | null;
  estimateSize?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const keys = useMemo(() => rows.map((row) => row.key), [rows]);
  const getItemKey = useCallback(
    (index: number) => keys[index] ?? index,
    [keys],
  );
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = defaultRangeExtractor(range);
      const pinnedIndex = pinnedKey ? keys.indexOf(pinnedKey) : -1;
      const root = rootRef.current;
      if (root && scrollElement) {
        const rootRect = root.getBoundingClientRect();
        const scrollRect = scrollElement.getBoundingClientRect();
        const viewportPadding = estimateSize * DEFAULT_OVERSCAN;
        const outsideViewport =
          rootRect.bottom < scrollRect.top - viewportPadding ||
          rootRect.top > scrollRect.bottom + viewportPadding;
        if (outsideViewport) return pinnedIndex >= 0 ? [pinnedIndex] : [];
      }
      if (pinnedIndex < 0 || indexes.includes(pinnedIndex)) return indexes;
      return [...indexes, pinnedIndex].sort((left, right) => left - right);
    },
    [estimateSize, keys, pinnedKey, scrollElement],
  );
  const shouldVirtualize =
    rows.length > VIRTUAL_TREE_THRESHOLD && scrollElement !== null;
  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: shouldVirtualize,
    getScrollElement: () => scrollElement,
    estimateSize: () => estimateSize,
    getItemKey,
    rangeExtractor,
    overscan: DEFAULT_OVERSCAN,
    scrollMargin,
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !scrollElement || !shouldVirtualize) return;
    const update = () => {
      const rootRect = root.getBoundingClientRect();
      const scrollRect = scrollElement.getBoundingClientRect();
      setScrollMargin(
        rootRect.top - scrollRect.top + scrollElement.scrollTop,
      );
    };
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(update);
    observer?.observe(root);
    if (root.parentElement) observer?.observe(root.parentElement);
    observer?.observe(scrollElement);
    return () => observer?.disconnect();
  }, [rows.length, scrollElement, shouldVirtualize]);

  if (!shouldVirtualize) {
    return rows.map((row) => (
      <Fragment key={row.key}>{row.render()}</Fragment>
    ));
  }

  return (
    <div
      ref={rootRef}
      data-virtual-tree-list
      className="tw:relative tw:w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        return (
          <div
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            data-virtual-tree-row
            key={row.key}
            className="tw:absolute tw:top-0 tw:left-0 tw:w-full"
            style={{
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {row.render()}
          </div>
        );
      })}
    </div>
  );
}
