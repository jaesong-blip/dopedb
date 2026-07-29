import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { ConnectionId } from "../connections/domain";
import type {
  AcpPromptContext,
  AcpSessionChanged,
  AcpSessionFocus,
  AcpSessionId,
  AcpSessionSummary,
  AgentCliInfo,
  RetiredChatThreadId,
  RetiredChatArchiveMessage,
  RetiredChatArchiveThread,
} from "./domain";

export function startAgentAcpSession(
  connectionId: ConnectionId,
): Promise<AcpSessionFocus> {
  return invoke("start_agent_acp_session", { connectionId });
}

export function resumeAgentAcpSession(
  id: AcpSessionId,
): Promise<AcpSessionFocus> {
  return invoke("resume_agent_acp_session", { id });
}

export function listAgentAcpSessions(): Promise<AcpSessionSummary[]> {
  return invoke("list_agent_acp_sessions");
}

export function focusAgentAcpSession(
  id: AcpSessionId,
  afterSequence?: number,
): Promise<AcpSessionFocus> {
  return invoke("focus_agent_acp_session", {
    id,
    afterSequence: afterSequence ?? null,
  });
}

export function promptAgentAcpSession(
  id: AcpSessionId,
  prompt: string,
  context: AcpPromptContext,
): Promise<void> {
  return invoke("prompt_agent_acp_session", {
    id,
    prompt,
    context,
  });
}

export function cancelAgentAcpSession(id: AcpSessionId): Promise<void> {
  return invoke("cancel_agent_acp_session", { id });
}

export function respondAgentAcpPermission(
  id: AcpSessionId,
  requestId: string,
  optionId: string | null,
): Promise<void> {
  return invoke("respond_agent_acp_permission", {
    id,
    requestId,
    optionId,
  });
}

export function closeAgentAcpSession(id: AcpSessionId): Promise<void> {
  return invoke("close_agent_acp_session", { id });
}

export function onAgentAcpChanged(
  listener: (event: AcpSessionChanged) => void,
): Promise<UnlistenFn> {
  return listen<AcpSessionChanged>("agent-acp:changed", (event) =>
    listener(event.payload)
  );
}

/** Detects local Agent CLI readiness without reading or transferring credentials. */
export function detectAgentClis(): Promise<AgentCliInfo[]> {
  return invoke("detect_agent_clis");
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
