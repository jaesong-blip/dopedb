// Authoritative session reads for sensitive workspace API routes. Browser cookie
// caching remains enabled for UX, but these calls must observe durable revocation.
import "server-only";

import { auth } from "./auth";

/**
 * Keep browser-cookie and native-Bearer authentication mutually exclusive.
 *
 * Better Auth's bearer plugin deliberately falls through when a malformed or
 * invalid Authorization value cannot be verified. Passing the original request
 * headers in that case would let a valid browser cookie authenticate a route
 * that explicitly opted into native Bearer authority. Once Authorization is
 * present, preserve only that proof and fail closed instead of falling back to
 * any ambient cookie.
 */
export function authoritativeSessionHeaders(request: Pick<Request, "headers">): Headers {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return request.headers;
  return new Headers({ authorization });
}

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
    headers: authoritativeSessionHeaders(request),
    query: { disableCookieCache: true },
  });
}
