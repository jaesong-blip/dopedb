/** ACP conversation, credential-free CLI status, and retired archive contracts. */

import type { ConnectionId } from "../connections/domain";

declare const retiredChatThreadIdBrand: unique symbol;
declare const retiredChatMessageIdBrand: unique symbol;
declare const acpSessionIdBrand: unique symbol;

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

export type AcpSessionId = string & {
  readonly [acpSessionIdBrand]: "AcpSessionId";
};

export function acpSessionId(value: string): AcpSessionId {
  return value as AcpSessionId;
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

export type AcpSessionLifecycle =
  | "starting"
  | "ready"
  | "running"
  | "waitingPermission"
  | "failed"
  | "closed";

export interface AcpSessionSummary {
  id: AcpSessionId;
  connectionId: ConnectionId;
  provider: "codex";
  title: string;
  lifecycle: AcpSessionLifecycle;
  acpSessionId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AcpPermissionOption {
  id: string;
  name: string;
  kind:
    | "allowOnce"
    | "allowAlways"
    | "rejectOnce"
    | "rejectAlways"
    | "unknown";
}

type AcpEventBase = {
  sessionId: AcpSessionId;
  sequence: number;
  createdAt: string;
};

export type AcpSessionEvent = AcpEventBase &
  (
    | {
        type: "userMessage";
        text: string;
        attachments: string[];
      }
    | {
        type: "sessionUpdate";
        update: Record<string, unknown>;
      }
    | {
        type: "permissionRequest";
        requestId: string;
        toolCall: Record<string, unknown>;
        options: AcpPermissionOption[];
      }
    | {
        type: "turnEnd";
        stopReason: string;
      }
    | {
        type: "status";
        lifecycle: AcpSessionLifecycle;
      }
    | {
        type: "error";
        message: string;
      }
  );

export interface AcpSessionFocus {
  session: AcpSessionSummary;
  events: AcpSessionEvent[];
  replayTruncated: boolean;
}

export interface AcpSessionChanged {
  session: AcpSessionSummary;
  event: AcpSessionEvent | null;
}

export interface AcpTableContext {
  database: string | null;
  schema: string | null;
  table: string;
  column: string | null;
  rowIndex: number | null;
  row: Record<string, unknown> | null;
}

export interface AcpPromptContext {
  database: string | null;
  documentName: string | null;
  documentText: string | null;
  table: AcpTableContext | null;
}
