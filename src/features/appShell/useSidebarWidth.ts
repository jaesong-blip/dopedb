import { useCallback, useState } from "react";

const MIN = 180;
const MAX = 520;
export const DEFAULT_SIDEBAR_WIDTH = 240;

function clamp(width: number) {
  return Math.min(MAX, Math.max(MIN, width));
}

export function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("sidebarW"));
    return saved >= MIN && saved <= MAX ? saved : DEFAULT_SIDEBAR_WIDTH;
  });

  const startDrag = useCallback(
    (event: { preventDefault(): void; clientX: number }) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const move = (next: MouseEvent) =>
        setWidth(clamp(startWidth + next.clientX - startX));
      const up = (next: MouseEvent) => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        localStorage.setItem(
          "sidebarW",
          String(clamp(startWidth + next.clientX - startX)),
        );
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [width],
  );

  const reset = useCallback(() => {
    setWidth(DEFAULT_SIDEBAR_WIDTH);
    localStorage.setItem("sidebarW", String(DEFAULT_SIDEBAR_WIDTH));
  }, []);

  return { width, startDrag, reset };
}
