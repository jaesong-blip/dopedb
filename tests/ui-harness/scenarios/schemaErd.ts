// Tier 1 — deferred schema overview에서 사용자가 상세 정보를 요청한 뒤 실제
// React Flow ERD와 저장 layout command 경계를 렌더한다.
import {
  analyticsCatalog,
  analyticsSnapshot,
} from "../fixtures/catalogs";
import { analyticsPostgres } from "../fixtures/connections";
import {
  ALL_RUBRIC,
  connectedIpc,
  connectedStorage,
  expectedCommands,
  shellLayout,
  SHELL_ROLES,
} from "./common";
import type { UiHarnessScenario } from "./types";

export const schemaErd: UiHarnessScenario = {
  id: "schema-erd",
  title: "Schema ERD — detailed catalog",
  viewport: "desktop",
  activeArea: "workspace",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage(),
  ipc: connectedIpc({
    get_schema: JSON.stringify(analyticsCatalog),
    get_catalog_snapshot: analyticsSnapshot,
    list_erd_layouts: [],
  }),
  benchmark: {
    referenceId: "DopeDB-2026.1-explorer-macos",
    referenceCloneScene: "first-run",
    requiredRegions: ["rail", "explorer", "workbench"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: expectedCommands(
      "get_catalog_overview",
      "get_catalog_snapshot",
      "get_safety",
      "get_schema",
      "list_erd_layouts",
      "list_sql_documents",
    ),
    visibleRoles: SHELL_ROLES,
    layout: shellLayout(),
  },
};
