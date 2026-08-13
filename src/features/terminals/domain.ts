/** Minimal connection-pinned Shell Terminal wire contract. */

import type {
  ConnectionEngine,
  ConnectionId,
} from "../connections/domain";
import type { WorkspaceId } from "../workspaces/domain";

declare const terminalSessionIdBrand: unique symbol;

export type TerminalSessionId = string & {
  readonly [terminalSessionIdBrand]: "TerminalSessionId";
};

export type TerminalLifecycle =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed";

export interface TerminalSize {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface TerminalCreateRequest {
  connectionId: ConnectionId;
  profile: "shell";
  size: TerminalSize;
}

export interface TerminalConnectionPin {
  workspaceId: WorkspaceId;
  accountScope: string;
  scopeGeneration: number;
  connectionId: ConnectionId;
  connectionRevision: number;
  connectionName: string;
  database: string;
  environment: string | null;
  engine: ConnectionEngine;
  policy: "readOnly" | "approvalRequired";
}

export interface TerminalSessionSummary {
  id: TerminalSessionId;
  name: string;
  profile: "shell";
  lifecycle: TerminalLifecycle;
  size: TerminalSize;
  connection: TerminalConnectionPin;
  createdAt: string;
  lastActivityAt: string;
  exit: {
    success: boolean;
    code: number | null;
    signal: string | null;
    at: string;
  } | null;
}

export interface TerminalOutputChunk {
  sessionId: TerminalSessionId;
  bytes: number[];
}

export interface TerminalStateEvent {
  session: TerminalSessionSummary;
}
