// Pure Terminal close-command policy keeps every UI affordance on one scoped path.
import type { TerminalSessionId, TerminalSessionSummary } from "./domain";

export type TerminalCloseAction = "one" | "others" | "right";
export type TerminalCloseResult = "closed" | "cancelled" | "stale" | "failed";

export function terminalCloseTargetIds(
  sessions: TerminalSessionSummary[],
  targetId: TerminalSessionId,
  action: TerminalCloseAction,
): TerminalSessionId[] {
  const index = sessions.findIndex((session) => session.id === targetId);
  if (index < 0) return [];
  if (action === "one") return [targetId];
  if (action === "others") {
    return sessions
      .filter((session) => session.id !== targetId)
      .map((session) => session.id);
  }
  return sessions.slice(index + 1).map((session) => session.id);
}

export async function runTerminalCloseBatch(
  ids: TerminalSessionId[],
  close: (id: TerminalSessionId) => Promise<TerminalCloseResult>,
): Promise<TerminalCloseResult[]> {
  const results: TerminalCloseResult[] = [];
  for (const id of ids) {
    const result = await close(id);
    results.push(result);
    if (result !== "closed") break;
  }
  return results;
}

export function shouldCloseTerminalFromShortcut({
  key,
  metaKey,
  ctrlKey,
  altKey,
  shiftKey,
  focusInsideDock,
}: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  focusInsideDock: boolean;
}): boolean {
  return (
    focusInsideDock &&
    key.toLowerCase() === "w" &&
    (metaKey || ctrlKey) &&
    !altKey &&
    !shiftKey
  );
}
