// Authoritative session reads for sensitive workspace API routes. Browser cookie
// caching remains enabled for UX, but these calls must observe durable revocation.
import "server-only";

import { auth } from "./auth";

/**
 * Resolves the current Better Auth session from its durable server-side store.
 *
 * Better Auth's supported `disableCookieCache` query deliberately bypasses the
 * five-minute browser cookie cache configured for ordinary navigation. Keep this
 * as the only sensitive-route session port so a revoked cookie cannot authorize
 * membership, provider, or resource work.
 */
export function authoritativeSession(request: Request) {
  return auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
}
