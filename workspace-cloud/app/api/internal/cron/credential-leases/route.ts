// Cloudflare-scheduled entrypoint for durable provider-credential cleanup.
// Authentication is independent of browser sessions and the response never includes
// provider details.
import { cronRequestAuthorized } from "../../../../../lib/cron-auth";
import { privateJson } from "../../../../../lib/http";
import { cleanupProviderDiscoveryReceipts } from "../../../../../lib/provider-discovery-receipt-store";
import { cleanupExpiredManagedLeases } from "../../../../../lib/provider-integrations";
import { cleanupWorkspaceRetention } from "../../../../../lib/workspace-lifecycle";
import { deliverAnalysisSignalEmailNotifications } from "../../../../../lib/signal-notifications";
import { cleanupExpiredAnalysisResults } from "../../../../../lib/workspace-analysis-retention";
import { cleanupExpiredRateLimits } from "../../../../../lib/rate-limit";
import {
  nextMaintenanceBackgroundRunAt,
  workspaceSchedulerReceipt,
  workspaceSchedulerRequest,
  workspaceSchedulerResponseHeaders,
} from "../../../../../lib/workspace-background-scheduler";

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronRequestAuthorized(request) || !workspaceSchedulerRequest(request)) {
    return privateJson({ error: "Unauthorized" }, { status: 401 });
  }
  const [
    result,
    discoveryReceiptsDeleted,
    analysisResults,
    analysisEmails,
    expiredRateLimits,
  ] = await Promise.all([
    cleanupExpiredManagedLeases({ limit: 10 }),
    cleanupProviderDiscoveryReceipts(),
    cleanupExpiredAnalysisResults(),
    deliverAnalysisSignalEmailNotifications(),
    cleanupExpiredRateLimits(),
  ]);
  // Run retention after lease cleanup. A due workspace remains deferred until
  // every provider credential is durably revoked, then succeeds on a later tick.
  const retention = await cleanupWorkspaceRetention();
  const nextRunAt = await nextMaintenanceBackgroundRunAt();
  return privateJson(
    {
      ok: result.deferred === 0 && retention.workspacesDeferred === 0,
      scheduler: workspaceSchedulerReceipt(nextRunAt),
      ...result,
      discoveryReceiptsDeleted,
      analysisResults,
      analysisEmails,
      expiredRateLimits,
      retention,
    },
    {
      status: result.deferred === 0 && retention.workspacesDeferred === 0 ? 200 : 503,
      headers: workspaceSchedulerResponseHeaders(),
    },
  );
}
