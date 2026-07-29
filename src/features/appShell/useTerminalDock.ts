import { useCallback, useRef, useState } from "react";

import {
  clampTerminalDockWidth,
  TERMINAL_DOCK_DEFAULT_WIDTH,
} from "../terminals/layout";

const LEGACY_DEFAULT_WIDTHS = new Set([360, 480]);

export function useTerminalDock() {
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem("terminalDockOpen");
    if (saved !== null) return saved !== "0";
    return localStorage.getItem("agentDockOpen") !== "0";
  });
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("terminalDockWidth"));
    const requested =
      LEGACY_DEFAULT_WIDTHS.has(saved)
        ? TERMINAL_DOCK_DEFAULT_WIDTH
        : saved || TERMINAL_DOCK_DEFAULT_WIDTH;
    return clampTerminalDockWidth(
      requested,
      typeof window === "undefined" ? 1_280 : window.innerWidth,
    );
  });
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const show = useCallback(() => {
    localStorage.setItem("terminalDockOpen", "1");
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    localStorage.setItem("terminalDockOpen", "0");
    setOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  const resize = useCallback((next: number) => {
    const bounded = clampTerminalDockWidth(next, window.innerWidth);
    setWidth(bounded);
    localStorage.setItem("terminalDockWidth", String(bounded));
  }, []);

  return { open, width, buttonRef, show, close, resize };
}
