// Read-only query options for local Agent CLI status and the retired chat archive.
// These keep the feature's Tauri boundary local while sharing TanStack Query cache entries.
import { queryOptions } from "@tanstack/react-query";

import type { RetiredChatThreadId } from "./domain";
import { agentQueryKeys } from "./queryKeys";
import {
  detectAgentClis,
  getAgentUsage,
  getRetiredChatArchiveMessages,
  listRetiredChatArchiveThreads,
} from "./tauriAdapter";

// Short staleTime keeps an explicit refresh responsive without re-spawning local CLIs on render.
export function agentCliDetectionQuery() {
  return queryOptions({
    queryKey: agentQueryKeys.cliStatus(),
    staleTime: 15_000,
    queryFn: detectAgentClis,
  });
}

// Quota moves slowly and every read calls the provider, so poll on a wide interval.
export function agentUsageQuery() {
  return queryOptions({
    queryKey: agentQueryKeys.usage(),
    staleTime: 60_000,
    refetchInterval: 300_000,
    queryFn: getAgentUsage,
  });
}

export function retiredChatArchiveThreadsQuery() {
  return queryOptions({
    queryKey: agentQueryKeys.retiredArchiveThreads(),
    staleTime: 5_000,
    queryFn: listRetiredChatArchiveThreads,
  });
}

export function retiredChatArchiveMessagesQuery(
  threadId: RetiredChatThreadId | null,
) {
  return queryOptions({
    queryKey: agentQueryKeys.retiredArchiveMessages(threadId ?? ""),
    enabled: threadId !== null,
    staleTime: 5_000,
    queryFn: () => getRetiredChatArchiveMessages(threadId!),
  });
}
