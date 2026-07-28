// Tier 0 — 실제 TerminalDock과 connection-pinned PTY session을 오른쪽 tool
// window로 연다. terminal command는 strict fixture 밖으로 나갈 수 없다.
import { analyticsPostgres } from "../fixtures/connections";
import {
  fixtureTerminalFocus,
  fixtureTerminalSession,
} from "../fixtures/terminals";
import { HARNESS_STORAGE_KEYS } from "../runtime/storage";
import {
  ALL_RUBRIC,
  connectedIpc,
  connectedStorage,
  expectedCommands,
  shellLayout,
  SHELL_ROLES,
} from "./common";
import type { UiHarnessScenario } from "./types";

export const terminalOpen: UiHarnessScenario = {
  id: "terminal-open",
  title: "Terminal Dock — connection pinned",
  viewport: "desktop",
  activeArea: "workspace",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage({
    [HARNESS_STORAGE_KEYS.terminalDockOpen]: "1",
  }),
  ipc: connectedIpc({
    terminal_list: [fixtureTerminalSession],
    terminal_focus: fixtureTerminalFocus,
    terminal_resize: null,
  }),
  benchmark: {
    referenceId: "DopeDB-2026.1-assistant-macos",
    referenceCloneScene: "assistant-open",
    requiredRegions: ["rail", "explorer", "workbench", "assistant"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: expectedCommands(
      "get_catalog_overview",
      "get_safety",
      "list_sql_documents",
      "terminal_focus",
      "terminal_list",
      "terminal_resize",
    ),
    visibleRoles: [
      ...SHELL_ROLES,
      { role: "tab", name: "Analytics shell" },
    ],
    layout: shellLayout(true),
    focusOrder: ["workspace", "explorer", "workbench", "terminal"],
  },
};
