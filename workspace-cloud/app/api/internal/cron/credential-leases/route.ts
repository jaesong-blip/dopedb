// Vercel Cron entrypoint for durable provider-credential cleanup. Authentication is
// independent of browser sessions and the response never includes provider details.
import { timingSafeEqual } from "node:crypto";
import { env } from "../../../../../lib/env";
import { privateJson } from "../../../../../lib/http";
import { cleanupProviderDiscoveryReceipts } from "../../../../../lib/provider-discovery-receipt-store";
import { cleanupExpiredManagedLeases } from "../../../../../lib/provider-integrations";
import { cleanupWorkspaceRetention } from "../../../../../lib/workspace-lifecycle";

export const maxDuration = 60;

function authorized(request: Request) {
  const secret = env.cronSecret();
  if (!secret || secret.length < 16) return false;
  const actual = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return privateJson({ error: "Unauthorized" }, { status: 401 });
  }
  const [result, discoveryReceiptsDeleted] = await Promise.all([
    cleanupExpiredManagedLeases({ limit: 10 }),
    cleanupProviderDiscoveryReceipts(),
  ]);
  // Run retention after lease cleanup. A due workspace remains deferred until
  // every provider credential is durably revoked, then succeeds on a later tick.
  const retention = await cleanupWorkspaceRetention();
  return privateJson(
    {
      ok: result.deferred === 0 && retention.workspacesDeferred === 0,
      ...result,
      discoveryReceiptsDeleted,
      retention,
    },
    { status: result.deferred === 0 && retention.workspacesDeferred === 0 ? 200 : 503 },
  );
}
