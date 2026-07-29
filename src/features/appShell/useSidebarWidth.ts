import { useCallback, useState } from "react";

const EXPLORER_STORAGE_KEY = "sidebarW";
const LOCAL_HISTORY_STORAGE_KEY = "localHistorySidebarW";
const EXPLORER_MIN = 180;
const LOCAL_HISTORY_MIN = 300;
const MAX = 520;
export const DEFAULT_SIDEBAR_WIDTH = 304;
export const DEFAULT_LOCAL_HISTORY_WIDTH = 456;

type SidebarKind = "databaseExplorer" | "localHistory";

function minimum(kind: SidebarKind) {
  return kind === "localHistory" ? LOCAL_HISTORY_MIN : EXPLORER_MIN;
}

function defaultWidth(kind: SidebarKind) {
  return kind === "localHistory"
    ? DEFAULT_LOCAL_HISTORY_WIDTH
    : DEFAULT_SIDEBAR_WIDTH;
}

function storageKey(kind: SidebarKind) {
  return kind === "localHistory"
    ? LOCAL_HISTORY_STORAGE_KEY
    : EXPLORER_STORAGE_KEY;
}

function clamp(kind: SidebarKind, width: number) {
  return Math.min(MAX, Math.max(minimum(kind), width));
}

function readWidth(kind: SidebarKind) {
  const saved = Number(localStorage.getItem(storageKey(kind)));
  if (kind === "localHistory" && saved === 360) {
    return DEFAULT_LOCAL_HISTORY_WIDTH;
  }
  return saved >= minimum(kind) && saved <= MAX
    ? saved
    : defaultWidth(kind);
}

export function useSidebarWidth(kind: SidebarKind) {
  const [widths, setWidths] = useState(() => ({
    databaseExplorer: readWidth("databaseExplorer"),
    localHistory: readWidth("localHistory"),
  }));
  const width = widths[kind];

  const startDrag = useCallback(
    (event: { preventDefault(): void; clientX: number }) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const move = (next: MouseEvent) => {
        const nextWidth = clamp(
          kind,
          startWidth + next.clientX - startX,
        );
        setWidths((current) => ({ ...current, [kind]: nextWidth }));
      };
      const up = (next: MouseEvent) => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        const nextWidth = clamp(
          kind,
          startWidth + next.clientX - startX,
        );
        localStorage.setItem(
          storageKey(kind),
          String(nextWidth),
        );
        setWidths((current) => ({ ...current, [kind]: nextWidth }));
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [kind, width],
  );

  const reset = useCallback(() => {
    const nextWidth = defaultWidth(kind);
    setWidths((current) => ({ ...current, [kind]: nextWidth }));
    localStorage.setItem(storageKey(kind), String(nextWidth));
  }, [kind]);

  return { width, startDrag, reset };
}
