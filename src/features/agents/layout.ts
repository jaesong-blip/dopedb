/** Responsive geometry policy for the DopeDB-style AI Chat right anchor. */
export const AGENT_DOCK_DEFAULT_WIDTH = 396;
export const AGENT_DOCK_MIN_WIDTH = 360;
export const AGENT_DOCK_MAX_WIDTH = 680;

export function normalizeAgentDockWidth(requestedWidth: number): number {
  return Math.round(
    Math.min(
      AGENT_DOCK_MAX_WIDTH,
      Math.max(AGENT_DOCK_MIN_WIDTH, requestedWidth),
    ),
  );
}

export function clampAgentDockWidth(
  requestedWidth: number,
  viewportWidth: number,
): number {
  const viewportMaximum = Math.max(
    AGENT_DOCK_MIN_WIDTH,
    Math.floor(viewportWidth * 0.55),
  );
  return Math.round(
    Math.min(
      viewportMaximum,
      normalizeAgentDockWidth(requestedWidth),
    ),
  );
}
