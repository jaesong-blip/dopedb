// One bounded Vercel execution advances durable code-index jobs and then repairs
// missed GitHub deliveries. Repository analysis is intentionally split across
// invocations; this route never needs a container or a long-lived process.
import { cronRequestAuthorized } from "../../../../../lib/cron-auth";
import { privateJson } from "../../../../../lib/http";
import { processCodeIndexQueue } from "../../../../../lib/knowledge/code-indexer";
import { reconcileGithubKnowledgeSources } from "../../../../../lib/knowledge/reconciliation";

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronRequestAuthorized(request)) {
    return privateJson({ error: "Unauthorized" }, { status: 401 });
  }
  // One durable phase plus one ref reconciliation has a hard upper bound below
  // maxDuration; subsequent phases resume on the next one-minute invocation.
  const index = await processCodeIndexQueue({ maxSteps: 1, deadlineMs: 40_000 });
  const reconciliation = await reconcileGithubKnowledgeSources(1);
  return privateJson({
    ok: index.failed === 0 && reconciliation.deferred === 0,
    index,
    reconciliation,
  });
}
