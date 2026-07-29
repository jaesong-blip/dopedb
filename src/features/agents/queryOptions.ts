// Read-only query options for local Agent CLI status and the retired chat archive.
// These keep the feature's Tauri boundary local while sharing TanStack Query cache entries.
import { queryOptions } from "@tanstack/react-query";

import type { RetiredChatThreadId } from "./domain";
import { agentQueryKeys } from "./queryKeys";
import {
  detectAgentClis,
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
