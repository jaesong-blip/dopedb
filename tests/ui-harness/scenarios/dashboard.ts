// Tier 1 — Dashboard library와 명시적으로 실행된 한 tile만 live result를 받는
// 실제 TanStack Query 경로를 검증한다.
import { analyticsPostgres } from "../fixtures/connections";
import {
  fixtureDashboards,
  revenueDashboardResult,
} from "../fixtures/dashboards";
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

export const dashboard: UiHarnessScenario = {
  id: "dashboard",
  title: "Dashboard — one explicitly executed tile",
  viewport: "desktop",
  activeArea: "dashboard",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage({
    [HARNESS_STORAGE_KEYS.appArea]: "dashboard",
    [HARNESS_STORAGE_KEYS.tab]: "dashboard",
  }),
  ipc: connectedIpc({
    list_dashboards: fixtureDashboards,
    run_dashboard: revenueDashboardResult,
  }),
  benchmark: {
    referenceId: "DopeDB-2026.1-data-editor-macos",
    referenceCloneScene: "data-editor",
    requiredRegions: ["rail", "explorer", "workbench"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: expectedCommands(
      "get_safety",
      "list_dashboards",
      "list_sql_documents",
      "run_dashboard",
    ),
    commandCounts: { run_dashboard: 1 },
    visibleRoles: SHELL_ROLES,
    layout: shellLayout(),
  },
};
