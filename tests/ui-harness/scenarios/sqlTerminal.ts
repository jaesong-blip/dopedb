// Tier 1 — 저장된 multi-statement SQL 문서, 실제 result surface와 Terminal Dock을
// 함께 연다. Channel stream 대신 제품의 durable script command 경로를 사용한다.
import { analyticsCatalog } from "../fixtures/catalogs";
import { analyticsPostgres } from "../fixtures/connections";
import {
  analyticsSqlDocument,
  revenueScriptOutcome,
  revenueScriptProposal,
} from "../fixtures/queries";
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

export const sqlTerminal: UiHarnessScenario = {
  id: "sql-terminal",
  title: "SQL document with results and Terminal",
  viewport: "desktop",
  activeArea: "workspace",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage({
    [HARNESS_STORAGE_KEYS.tab]: "sql",
    [HARNESS_STORAGE_KEYS.terminalDockOpen]: "1",
  }),
  ipc: connectedIpc({
    list_sql_documents: [analyticsSqlDocument],
    get_schema: JSON.stringify(analyticsCatalog),
    propose_script: revenueScriptProposal,
    run_script: revenueScriptOutcome,
    terminal_list: [fixtureTerminalSession],
    terminal_focus: fixtureTerminalFocus,
    terminal_resize: null,
  }),
  benchmark: {
    referenceId: "DopeDB-2026.1-query-console-macos",
    referenceCloneScene: "query-console",
    requiredRegions: ["rail", "explorer", "workbench", "assistant"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: expectedCommands(
      "get_safety",
      "get_schema",
      "list_sql_documents",
      "propose_script",
      "run_script",
      "terminal_focus",
      "terminal_list",
      "terminal_resize",
    ),
    visibleRoles: [
      ...SHELL_ROLES,
      { role: "tab", name: "Revenue review" },
      { role: "tab", name: "Analytics shell" },
    ],
    layout: shellLayout(true),
  },
};
