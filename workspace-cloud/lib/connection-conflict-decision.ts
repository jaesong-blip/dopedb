export type ConnectionConflictResolution = "server" | "candidate" | "dismissed";

/**
 * Applying a candidate only creates a new main-line revision when the current
 * payload differs. If the current server revision already has the candidate
 * payload, keeping that exact revision is the only valid audited decision.
 */
export function candidateConflictResolution({
  currentMatchesServer,
  currentMatchesCandidate,
}: {
  currentMatchesServer: boolean;
  currentMatchesCandidate: boolean;
}): Extract<ConnectionConflictResolution, "server" | "candidate"> {
  return currentMatchesServer && currentMatchesCandidate ? "server" : "candidate";
}
