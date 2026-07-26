/** Credential-free Agent CLI status and read-only retired chat archive contracts. */

import type { ConnectionId } from "../connections/domain";

declare const retiredChatThreadIdBrand: unique symbol;
declare const retiredChatMessageIdBrand: unique symbol;

/** Opaque identity for one immutable thread created by the retired in-app chat. */
export type RetiredChatThreadId = string & {
  readonly [retiredChatThreadIdBrand]: "RetiredChatThreadId";
};

/** Opaque identity for one immutable message in the retired chat archive. */
export type RetiredChatMessageId = string & {
  readonly [retiredChatMessageIdBrand]: "RetiredChatMessageId";
};

export function retiredChatThreadId(value: string): RetiredChatThreadId {
  return value as RetiredChatThreadId;
}

export function retiredChatMessageId(value: string): RetiredChatMessageId {
  return value as RetiredChatMessageId;
}

export type AgentProvider = "claude" | "codex";

export interface AgentCliInfo {
  id: AgentProvider;
  name: string;
  installed: boolean;
  authenticated: boolean;
  authMethod: string | null;
  note: string;
}

/** A persisted, read-only conversation created before Terminal sessions replaced chat. */
export interface RetiredChatArchiveThread {
  id: RetiredChatThreadId;
  provider: AgentProvider;
  connectionId: ConnectionId | null;
  title: string;
  cliSessionId: string | null;
  model: string | null;
  effort: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One persisted, read-only message row from a retired conversation. */
export interface RetiredChatArchiveMessage {
  id: RetiredChatMessageId;
  threadId: RetiredChatThreadId;
  role: "user" | "assistant";
  text: string;
  error: string | null;
  createdAt: string;
}
