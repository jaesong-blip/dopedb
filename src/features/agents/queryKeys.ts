import type { RetiredChatThreadId } from "./domain";

export const AGENT_WORKSPACE_QUERY_ROOTS = ["retiredChatArchive"] as const;

export const agentQueryKeys = {
  pluginStatus: () => ["agentAcpPlugins"] as const,
  cliStatus: () => ["agentClis"] as const,
  retiredArchiveThreads: () =>
    [AGENT_WORKSPACE_QUERY_ROOTS[0], "threads"] as const,
  retiredArchiveMessages: (threadId: RetiredChatThreadId | "") =>
    [AGENT_WORKSPACE_QUERY_ROOTS[0], "messages", threadId] as const,
};
