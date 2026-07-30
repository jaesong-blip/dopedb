import { useCallback, useRef, useState } from "react";

import {
  AGENT_DOCK_DEFAULT_WIDTH,
  clampAgentDockWidth,
  normalizeAgentDockWidth,
} from "../agents/layout";

const LEGACY_DEFAULT_WIDTHS = new Set([360, 392, 396, 480]);

export function useTerminalDock() {
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem("agentDockOpen");
    if (saved !== null) return saved !== "0";
    return localStorage.getItem("terminalDockOpen") !== "0";
  });
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("agentDockWidth"));
    const legacy = Number(localStorage.getItem("terminalDockWidth"));
    const requested =
      saved ||
      (LEGACY_DEFAULT_WIDTHS.has(legacy)
        ? AGENT_DOCK_DEFAULT_WIDTH
        : legacy || AGENT_DOCK_DEFAULT_WIDTH);
    return normalizeAgentDockWidth(requested);
  });
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const show = useCallback(() => {
    localStorage.setItem("agentDockOpen", "1");
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    localStorage.setItem("agentDockOpen", "0");
    setOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  const resize = useCallback((next: number) => {
    const bounded = clampAgentDockWidth(next, window.innerWidth);
    setWidth(bounded);
    localStorage.setItem("agentDockWidth", String(bounded));
  }, []);

  return { open, width, buttonRef, show, close, resize };
}
