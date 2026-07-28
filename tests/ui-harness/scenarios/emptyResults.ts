// Tier 2 — table fetch는 성공했지만 0 rows인 상태. loading/error와 구분되는
// 실제 TableData empty-result copy와 다음 행동을 검증한다.
import { analyticsCatalog, analyticsSnapshot } from "../fixtures/catalogs";
import { analyticsPostgres } from "../fixtures/connections";
import { emptyOrdersResult, tableReadIpc } from "../fixtures/queries";
import {
  ALL_RUBRIC,
  connectedIpc,
  connectedStorage,
  expectedCommands,
  shellLayout,
  SHELL_ROLES,
} from "./common";
import type { UiHarnessScenario } from "./types";

export const emptyResults: UiHarnessScenario = {
  id: "empty-results",
  title: "Table data — zero rows",
  viewport: "desktop",
  activeArea: "workspace",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage(),
  ipc: connectedIpc({
    get_schema: JSON.stringify(analyticsCatalog),
    get_catalog_snapshot: analyticsSnapshot,
    ...tableReadIpc(emptyOrdersResult, 0),
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
    visibleRoles: SHELL_ROLES,
    layout: shellLayout(),
  },
};
