import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { ActionSearchCloseReason } from "./ActionSearch";

/** Owns Action Search focus restoration and the global double-Shift command. */
export function useActionSearchDialog() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);
  const lastShiftAtRef = useRef(0);

  const show = useCallback((returnFocus?: HTMLElement | null) => {
    const activeElement = document.activeElement;
    returnFocusRef.current =
      returnFocus ??
      (activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      activeElement !== document.documentElement
        ? activeElement
        : buttonRef.current);
    setOpen(true);
  }, []);

  const close = useCallback((reason: ActionSearchCloseReason) => {
    restoreFocusRef.current = reason === "dismiss";
    setOpen(false);
  }, []);

  useEffect(() => {
    if (open || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const focusTarget = returnFocusRef.current?.isConnected
        ? returnFocusRef.current
        : buttonRef.current;
      returnFocusRef.current = null;
      focusTarget?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    const openOnDoubleShift = (event: KeyboardEvent) => {
      if (event.key !== "Shift" || event.repeat) return;
      const now = performance.now();
      if (now - lastShiftAtRef.current < 500) {
        event.preventDefault();
        lastShiftAtRef.current = 0;
        show();
      } else {
        lastShiftAtRef.current = now;
      }
    };
    window.addEventListener("keydown", openOnDoubleShift);
    return () => window.removeEventListener("keydown", openOnDoubleShift);
  }, [show]);

  return { open, buttonRef, show, close };
}
