// Sole frontend owner of the bounded Shell Terminal command names. Agent sessions
// remain owned by ACP and do not pass through this adapter.
import { Channel, invoke } from "../../ipc/core";

import type {
  TerminalCreateRequest,
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

export function createShellTerminal(
  request: TerminalCreateRequest,
  onOutput: Channel<TerminalOutputChunk>,
): Promise<TerminalSessionSummary> {
  return invoke("terminal_create", { request, onOutput });
}

export function writeShellTerminal(
  id: TerminalSessionId,
  bytes: number[],
): Promise<void> {
  return invoke("terminal_write", { id, bytes });
}

export function resizeShellTerminal(
  id: TerminalSessionId,
  size: TerminalSize,
): Promise<void> {
  return invoke("terminal_resize", { id, size });
}

export function closeShellTerminal(id: TerminalSessionId): Promise<void> {
  return invoke("terminal_close", { id });
}
