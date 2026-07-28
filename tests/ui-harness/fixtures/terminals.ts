// Terminal fixture는 connection-pinned public session summary만 표현한다.
// PTY output, shell environment와 credential은 포함하지 않는다.
import {
  terminalSessionId,
  type TerminalFocusReceipt,
  type TerminalSessionSummary,
} from "../../../src/features/terminals/domain";
import { analyticsPostgres } from "./connections";
import { localWorkspace } from "./identities";

export const fixtureTerminalSession = {
  id: terminalSessionId("fixture-terminal-session-0001"),
  name: "Analytics shell",
  profile: "shell",
  lifecycle: "running",
  size: {
    cols: 100,
    rows: 30,
    pixelWidth: 0,
    pixelHeight: 0,
  },
  connection: {
    workspaceId: localWorkspace.id,
    accountScope: "fixture-local",
    scopeGeneration: 1,
    connectionId: analyticsPostgres.id,
    connectionRevision: 1,
    connectionName: analyticsPostgres.name,
    database: analyticsPostgres.database,
    environment: analyticsPostgres.env,
    engine: analyticsPostgres.engine,
    policy: "readOnly",
  },
  createdAt: "2026-07-28T08:00:00.000Z",
  lastActivityAt: "2026-07-28T08:59:00.000Z",
  exit: null,
} satisfies TerminalSessionSummary;

export const fixtureTerminalFocus = {
  session: fixtureTerminalSession,
  replayFrom: null,
  replayThrough: 0,
  replayTruncated: false,
} satisfies TerminalFocusReceipt;
