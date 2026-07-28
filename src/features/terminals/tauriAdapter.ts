import { Channel, invoke } from "@tauri-apps/api/core";

import type {
  SkillSetupTerminalCreateRequest,
  SkillSetupTerminalSessionSummary,
  TerminalCreateRequest,
  TerminalFocusReceipt,
  TerminalOutputChunk,
  TerminalSessionId,
  TerminalSessionSummary,
  TerminalSize,
} from "./domain";

export function terminalOutputChannel(
  onMessage: (message: TerminalOutputChunk) => void,
): Channel<TerminalOutputChunk> {
  const channel = new Channel<TerminalOutputChunk>();
  channel.onmessage = onMessage;
  return channel;
}

export function terminalCreate(
  request: TerminalCreateRequest,
  onOutput: Channel<TerminalOutputChunk>,
): Promise<TerminalSessionSummary> {
  return invoke("terminal_create", { request, onOutput });
}

export function terminalList(): Promise<TerminalSessionSummary[]> {
  return invoke("terminal_list");
}

export function terminalFocus(
  id: TerminalSessionId,
  afterSequence: number | null,
  onOutput: Channel<TerminalOutputChunk>,
): Promise<TerminalFocusReceipt> {
  return invoke("terminal_focus", { id, afterSequence, onOutput });
}

export function terminalWrite(
  id: TerminalSessionId,
  bytes: number[],
): Promise<void> {
  return invoke("terminal_write", { id, bytes });
}

export function terminalResize(
  id: TerminalSessionId,
  size: TerminalSize,
): Promise<void> {
  return invoke("terminal_resize", { id, size });
}

export function terminalKill(
  id: TerminalSessionId,
): Promise<TerminalSessionSummary> {
  return invoke("terminal_kill", { id });
}

export function terminalClose(id: TerminalSessionId): Promise<void> {
  return invoke("terminal_close", { id });
}

export function terminalRestart(
  id: TerminalSessionId,
  onOutput: Channel<TerminalOutputChunk>,
): Promise<TerminalSessionSummary> {
  return invoke("terminal_restart", { id, onOutput });
}

export function terminalRename(
  id: TerminalSessionId,
  name: string,
): Promise<TerminalSessionSummary> {
  return invoke("terminal_rename", { id, name });
}

export function skillSetupTerminalCreate(
  request: SkillSetupTerminalCreateRequest,
  onOutput: Channel<TerminalOutputChunk>,
): Promise<SkillSetupTerminalSessionSummary> {
  return invoke("skill_setup_terminal_create", { request, onOutput });
}

export function skillSetupTerminalWrite(
  id: TerminalSessionId,
  bytes: number[],
): Promise<void> {
  return invoke("skill_setup_terminal_write", { id, bytes });
}

export function skillSetupTerminalResize(
  id: TerminalSessionId,
  size: TerminalSize,
): Promise<void> {
  return invoke("skill_setup_terminal_resize", { id, size });
}

export function skillSetupTerminalClose(
  id: TerminalSessionId,
): Promise<void> {
  return invoke("skill_setup_terminal_close", { id });
}

export function terminalShutdownAll(): Promise<void> {
  return invoke("terminal_shutdown_all");
}
