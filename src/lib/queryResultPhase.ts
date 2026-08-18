/**
 * Canonical read-query priority. Empty collections are interpreted only after
 * this returns `loaded`; an error can therefore never masquerade as empty.
 */
export type QueryResultPhase =
  | "coldError"
  | "coldLoading"
  | "staleError"
  | "loaded";

export function queryResultPhase(
  data: unknown,
  error: unknown,
): QueryResultPhase {
  if (data === undefined) return error ? "coldError" : "coldLoading";
  return error ? "staleError" : "loaded";
}
