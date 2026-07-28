/** Terminal Dock identities and immutable connection-pinned wire contracts. */

import type {
  ConnectionEngine,
  ConnectionId,
} from "../connections/domain";
import type { WorkspaceId } from "../workspaces/domain";

declare const terminalSessionIdBrand: unique symbol;
declare const skillSetupCommandDraftBrand: unique symbol;

export type TerminalSessionId = string & {
  readonly [terminalSessionIdBrand]: "TerminalSessionId";
};

export function terminalSessionId(value: string): TerminalSessionId {
  return value as TerminalSessionId;
}

export type SkillSetupCommandDraft = string & {
  readonly [skillSetupCommandDraftBrand]: "SkillSetupCommandDraft";
};

export function skillSetupCommandDraft(value: string): SkillSetupCommandDraft {
  if (value.length === 0 || value.length > 4 * 1024) {
    throw new Error("Skill setup command draft length is invalid");
  }
  for (const character of value) {
    if (
      character === "\u007f" ||
      character.charCodeAt(0) < 0x20 ||
      (character.charCodeAt(0) >= 0x80 && character.charCodeAt(0) <= 0x9f)
    ) {
      throw new Error("Skill setup command draft contains a control character");
    }
  }
  return value as SkillSetupCommandDraft;
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
