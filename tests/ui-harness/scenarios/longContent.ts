// Tier 2 — 긴 connection/table/column/JSON 값이 adjacent control을 밀어내지
// 않는지 actual App의 Explorer와 DataGrid에서 함께 검증한다.
import { analyticsCatalog, analyticsSnapshot } from "../fixtures/catalogs";
import { analyticsPostgres } from "../fixtures/connections";
import { longAuditResult, tableReadIpc } from "../fixtures/queries";
import {
  ALL_RUBRIC,
  connectedIpc,
  connectedStorage,
  expectedCommands,
  shellLayout,
  SHELL_ROLES,
} from "./common";
import type { UiHarnessScenario } from "./types";

export const longContent: UiHarnessScenario = {
  id: "long-content",
  title: "Long identifiers and JSON values",
  viewport: "compact",
  activeArea: "workspace",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage(),
  ipc: connectedIpc({
    get_schema: JSON.stringify(analyticsCatalog),
    get_catalog_snapshot: analyticsSnapshot,
    ...tableReadIpc(longAuditResult, 2_048_000),
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
    layout: shellLayout(false, 260),
  },
};
