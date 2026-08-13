import { useCallback, useEffect, useRef, useState } from "react";

export function useResponsiveShell() {
  const [agentOverlay, setAgentOverlay] = useState(
    () => window.matchMedia("(max-width: 900px)").matches,
  );
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 560px)").matches,
  );
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  const mainRef = useRef<HTMLElement | null>(null);

  const dismissMobileExplorer = useCallback((restoreRailFocus = false) => {
    setMobileExplorerOpen(false);
    if (restoreRailFocus) {
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            '.workbench-rail-button[aria-current="page"]',
          )
          ?.focus();
      });
    }
  }, []);

  const focusMainAfterMobileSelection = useCallback(() => {
    if (!window.matchMedia("(max-width: 560px)").matches) return;
    window.requestAnimationFrame(() =>
      mainRef.current?.focus({ preventScroll: true }),
    );
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const sync = () => setAgentOverlay(media.matches);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 560px)");
    const sync = () => {
      setCompact(media.matches);
      if (!media.matches) setMobileExplorerOpen(false);
    };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!mobileExplorerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissMobileExplorer(true);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [dismissMobileExplorer, mobileExplorerOpen]);

  return {
    agentOverlay,
    compact,
    mobileExplorerOpen,
    setMobileExplorerOpen,
    mainRef,
    dismissMobileExplorer,
    focusMainAfterMobileSelection,
  };
}
