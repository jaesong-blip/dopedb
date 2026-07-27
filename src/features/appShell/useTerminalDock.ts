import { useCallback, useRef, useState } from "react";

const MIN = 360;
const MAX = 720;
const DEFAULT = 480;

export function useTerminalDock() {
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem("terminalDockOpen");
    if (saved !== null) return saved !== "0";
    return localStorage.getItem("agentDockOpen") !== "0";
  });
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("terminalDockWidth"));
    return saved >= MIN && saved <= MAX ? saved : DEFAULT;
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
    const bounded = Math.min(MAX, Math.max(MIN, Math.round(next)));
    setWidth(bounded);
    localStorage.setItem("terminalDockWidth", String(bounded));
  }, []);

  return { open, width, buttonRef, show, close, resize };
}
