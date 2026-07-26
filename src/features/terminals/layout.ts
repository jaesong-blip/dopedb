/** Responsive geometry policy for the Terminal Dock shell. */
export const TERMINAL_DOCK_DEFAULT_WIDTH = 480;
export const TERMINAL_DOCK_MIN_WIDTH = 360;
export const TERMINAL_DOCK_MAX_WIDTH = 720;

export function clampTerminalDockWidth(
  requestedWidth: number,
  viewportWidth: number,
): number {
  const viewportMaximum = Math.max(
    TERMINAL_DOCK_MIN_WIDTH,
    Math.floor(viewportWidth * 0.55),
  );
  return Math.round(
    Math.min(
      TERMINAL_DOCK_MAX_WIDTH,
      viewportMaximum,
      Math.max(TERMINAL_DOCK_MIN_WIDTH, requestedWidth),
    ),
  );
}

export function terminalPopupPosition(
  anchor: { left: number; top: number; bottom: number },
  popup: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; width: number } {
  const margin = 8;
  const width = Math.min(popup.width, viewport.width - margin * 2);
  const left = Math.max(
    margin,
    Math.min(anchor.left, viewport.width - width - margin),
  );
  const below = anchor.bottom + 4;
  return {
    left,
    top:
      below + popup.height <= viewport.height - margin
        ? below
        : Math.max(margin, anchor.top - popup.height - 4),
    width,
  };
}
