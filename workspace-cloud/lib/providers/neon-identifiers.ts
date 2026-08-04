// Runtime-neutral Neon resource identifier validation. Keep this module free of
// Node and server-only imports so browser-side contract tests can share it.

export function neonSegment(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z0-9][a-z0-9-]{0,59}$/.test(value);
}
