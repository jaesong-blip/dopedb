// Tier 1 — Explorer의 orders를 실제로 열어 DataGrid toolbar, pagination,
// filter와 cell detail을 고정된 read proposal/result로 렌더한다.
import { analyticsCatalog, analyticsSnapshot } from "../fixtures/catalogs";
import { analyticsPostgres } from "../fixtures/connections";
import { ordersResult, tableReadIpc } from "../fixtures/queries";
import {
  ALL_RUBRIC,
  connectedIpc,
  connectedStorage,
  expectedCommands,
  shellLayout,
  SHELL_ROLES,
} from "./common";
import type { UiHarnessScenario } from "./types";

export const tableData: UiHarnessScenario = {
  id: "table-data",
  title: "Table data — orders",
  viewport: "desktop",
  activeArea: "workspace",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage(),
  ipc: connectedIpc({
    get_schema: JSON.stringify(analyticsCatalog),
    get_catalog_snapshot: analyticsSnapshot,
    ...tableReadIpc(ordersResult, 128_400),
  }),
  benchmark: {
    referenceId: "DopeDB-2026.1-data-editor-macos",
    referenceCloneScene: "data-editor",
    requiredRegions: ["rail", "explorer", "workbench"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: expectedCommands(
      "get_catalog_overview",
      "get_catalog_snapshot",
      "get_safety",
      "get_schema",
      "list_sql_documents",
      "propose_sql",
      "run_sql",
    ),
    commandCounts: { propose_sql: 2, run_sql: 2 },
    visibleRoles: [...SHELL_ROLES, { role: "table", count: 1 }],
    layout: shellLayout(),
  },
};
