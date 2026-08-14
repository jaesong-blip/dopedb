// One bounded Vercel execution advances durable code-index jobs and then repairs
// missed GitHub deliveries. Repository analysis is intentionally split across
// invocations; this route never needs a container or a long-lived process.
import { cronRequestAuthorized } from "../../../../../lib/cron-auth";
import { privateJson } from "../../../../../lib/http";
import { processCodeIndexQueue } from "../../../../../lib/knowledge/code-indexer";
import { reconcileGithubKnowledgeSources } from "../../../../../lib/knowledge/reconciliation";
import {
  nextKnowledgeBackgroundRunAt,
  workspaceSchedulerReceipt,
  workspaceSchedulerRequest,
  workspaceSchedulerResponseHeaders,
} from "../../../../../lib/workspace-background-scheduler";

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronRequestAuthorized(request) || !workspaceSchedulerRequest(request)) {
    return privateJson({ error: "Unauthorized" }, { status: 401 });
  }
  // Advance as many durable checkpoints as fit the 40-second budget. Every
  // phase has its own conservative start-budget and query timeout, so a large
  // repository progresses continuously without making the request unbounded.
  const index = await processCodeIndexQueue({ maxSteps: 10, deadlineMs: 40_000 });
  const reconciliation = await reconcileGithubKnowledgeSources(1);
  const nextRunAt = await nextKnowledgeBackgroundRunAt();
  return privateJson(
    {
      ok: index.failed === 0 && reconciliation.deferred === 0,
      scheduler: workspaceSchedulerReceipt(nextRunAt),
      index,
      reconciliation,
    },
    { headers: workspaceSchedulerResponseHeaders() },
  );
}
