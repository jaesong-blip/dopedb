import { invoke } from "@tauri-apps/api/core";

import type {
  AgentCliInfo,
  AgentUsage,
  RetiredChatThreadId,
  RetiredChatArchiveMessage,
  RetiredChatArchiveThread,
} from "./domain";

/** Detects local Agent CLI readiness without reading or transferring credentials. */
export function detectAgentClis(): Promise<AgentCliInfo[]> {
  return invoke("detect_agent_clis");
}

/** Reads remaining subscription quota; providers that cannot be read are omitted. */
export function getAgentUsage(): Promise<AgentUsage[]> {
  return invoke("agent_usage");
}

/** Lists persisted conversations from the retired in-app chat; the archive is read-only. */
export function listRetiredChatArchiveThreads(): Promise<
  RetiredChatArchiveThread[]
> {
  return invoke("list_retired_chat_archive_threads");
}

/** Reads one retired chat archive thread's messages, oldest first. */
export function getRetiredChatArchiveMessages(
  threadId: RetiredChatThreadId,
): Promise<RetiredChatArchiveMessage[]> {
  return invoke("get_retired_chat_archive_messages", { threadId });
}
