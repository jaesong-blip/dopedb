/** Terminal Dock identities and immutable connection-pinned wire contracts. */

import type {
  ConnectionEngine,
  ConnectionId,
} from "../connections/domain";
import type { WorkspaceId } from "../workspaces/domain";

declare const terminalSessionIdBrand: unique symbol;

export type TerminalSessionId = string & {
  readonly [terminalSessionIdBrand]: "TerminalSessionId";
};

export function terminalSessionId(value: string): TerminalSessionId {
  return value as TerminalSessionId;
}

export type TerminalProfile = "shell" | "codex" | "claude";
export type TerminalLifecycle =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed";
export type TerminalDatabasePolicy = "readOnly" | "approvalRequired";

export interface TerminalSize {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface TerminalCreateRequest {
  connectionId: ConnectionId;
  profile: TerminalProfile;
  size: TerminalSize;
  name?: string | null;
}

export interface SkillSetupTerminalCreateRequest {
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
  policy: TerminalDatabasePolicy;
}

export interface TerminalExit {
  success: boolean;
  code: number | null;
  signal: string | null;
  at: string;
}

export interface TerminalSessionSummary {
  id: TerminalSessionId;
  name: string;
  profile: TerminalProfile;
  lifecycle: TerminalLifecycle;
  size: TerminalSize;
  connection: TerminalConnectionPin;
  createdAt: string;
  lastActivityAt: string;
  exit: TerminalExit | null;
}

export interface SkillSetupTerminalSessionSummary {
  id: TerminalSessionId;
  lifecycle: TerminalLifecycle;
  size: TerminalSize;
  createdAt: string;
  lastActivityAt: string;
  exit: TerminalExit | null;
}

export interface TerminalOutputChunk {
  sessionId: TerminalSessionId;
  sequence: number;
  bytes: number[];
  replay: boolean;
}

export interface TerminalFocusReceipt {
  session: TerminalSessionSummary;
  replayFrom: number | null;
  replayThrough: number;
  replayTruncated: boolean;
}

export interface TerminalStateEvent {
  session: TerminalSessionSummary;
}

export interface TerminalExitEvent {
  sessionId: TerminalSessionId;
  exit: TerminalExit;
}

export interface SkillSetupTerminalStateEvent {
  session: SkillSetupTerminalSessionSummary;
}

export interface SkillSetupTerminalExitEvent {
  sessionId: TerminalSessionId;
  exit: TerminalExit;
}
