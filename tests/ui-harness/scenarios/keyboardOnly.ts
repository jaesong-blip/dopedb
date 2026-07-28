// Tier 2 — rail→explorer→workbench→terminal focus journey와 manual event trigger를
// mouse 없이 실행하는 장면이다.
import { analyticsPostgres } from "../fixtures/connections";
import {
  ALL_RUBRIC,
  connectedIpc,
  connectedStorage,
  CONNECTED_COMMANDS,
  shellLayout,
  SHELL_ROLES,
} from "./common";
import type { UiHarnessScenario } from "./types";

export const keyboardOnly: UiHarnessScenario = {
  id: "keyboard-only",
  title: "Keyboard-only workbench journey",
  viewport: "desktop",
  activeArea: "workspace",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage(),
  ipc: connectedIpc({
    audit_verify: { ok: true, firstBadIndex: null },
    list_history: [],
    terminal_list: [],
  }),
  events: [
    {
      trigger: "manual:operation-complete",
      event: "operation:changed",
      payload: {
        requestId: "fixture-request-0001",
        terminalSessionId: "fixture-terminal-session-0001",
        connectionId: analyticsPostgres.id,
        command: "schema.list",
        state: "completed",
        errorCode: null,
      },
      once: true,
    },
  ],
  benchmark: {
    referenceId: "DopeDB-2026.1-assistant-macos",
    referenceCloneScene: "assistant-open",
    requiredRegions: ["rail", "explorer", "workbench"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: CONNECTED_COMMANDS,
    visibleRoles: SHELL_ROLES,
    layout: shellLayout(),
    focusOrder: ["workspace", "explorer", "workbench", "terminal"],
  },
};
