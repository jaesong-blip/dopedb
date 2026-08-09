import { useCallback, useRef, useState } from "react";

import {
  AGENT_DOCK_DEFAULT_WIDTH,
  clampAgentDockWidth,
  normalizeAgentDockWidth,
} from "../agents/layout";

const LEGACY_DEFAULT_WIDTHS = new Set([360, 384, 392, 396, 480, 600]);
const DEFAULT_WIDTH_MIGRATION_KEY = "dopedb:agent-dock-default:v3";

function readAgentDockWidth() {
  const saved = Number(localStorage.getItem("agentDockWidth"));
  const legacy = Number(localStorage.getItem("terminalDockWidth"));
  const needsDefaultMigration =
    localStorage.getItem(DEFAULT_WIDTH_MIGRATION_KEY) !== "1";
  const requested =
    (needsDefaultMigration && LEGACY_DEFAULT_WIDTHS.has(saved)
      ? AGENT_DOCK_DEFAULT_WIDTH
      : saved) ||
    (needsDefaultMigration && LEGACY_DEFAULT_WIDTHS.has(legacy)
      ? AGENT_DOCK_DEFAULT_WIDTH
      : legacy || AGENT_DOCK_DEFAULT_WIDTH);
  const width = normalizeAgentDockWidth(requested);
  if (needsDefaultMigration) {
    localStorage.setItem(DEFAULT_WIDTH_MIGRATION_KEY, "1");
    if (saved || legacy) {
      localStorage.setItem("agentDockWidth", String(width));
    }
  }
  return width;
}

export function useTerminalDock() {
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem("agentDockOpen");
    if (saved !== null) return saved !== "0";
    return localStorage.getItem("terminalDockOpen") !== "0";
  });
  const [width, setWidth] = useState(readAgentDockWidth);
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
