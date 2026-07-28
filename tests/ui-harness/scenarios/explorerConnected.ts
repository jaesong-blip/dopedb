// Tier 0 — 연결이 선택된 Explorer. 여러 연결, 스키마 그룹, 긴 객체명의
// 밀도·정렬·ellipsis 계약을 실제 DatabaseExplorer로 검증한다.
import type { SqlDocument } from "../../../src/features/sqlDocuments/domain";
import { bootIpc, BOOT_COMMANDS } from "../fixtures/boot";
import { analyticsOverview, readOnlySafety } from "../fixtures/catalogs";
import { analyticsPostgres, stagingPostgres } from "../fixtures/connections";
import { HARNESS_STORAGE_KEYS } from "../runtime/storage";
import {
  ALL_RUBRIC,
  connectedStorage,
  shellLayout,
  SHELL_ROLES,
} from "./common";
import type { UiHarnessScenario } from "./types";

/** 저장된 쿼리 없음. Schema 문서가 복원되므로 SQL 문서를 활성화하지 않는다. */
const noSavedQueries = [] satisfies SqlDocument[];

export const explorerConnected: UiHarnessScenario = {
  id: "explorer-connected",
  title: "Explorer — 연결 선택됨",
  viewport: "desktop",
  activeArea: "workspace",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage({
    // Terminal Dock의 제품 기본값은 열림이다. 이 장면은 Explorer 밀도·정렬만
    // 판정하므로 명시적으로 닫고, dock은 전용 terminal 장면에서 검증한다.
    [HARNESS_STORAGE_KEYS.terminalDockOpen]: "0",
  }),
  ipc: bootIpc({
    list_connections: [analyticsPostgres, stagingPostgres],
    get_safety: readOnlySafety,
    get_catalog_overview: analyticsOverview,
    list_sql_documents: noSavedQueries,
  }),
  benchmark: {
    referenceId: "DopeDB-2026.1-explorer-macos",
    referenceCloneScene: "first-run",
    requiredRegions: ["rail", "explorer", "workbench"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: [
      ...BOOT_COMMANDS,
      "get_catalog_overview",
      "get_safety",
      "list_sql_documents",
    ].sort(),
    visibleRoles: SHELL_ROLES,
    layout: shellLayout(),
  },
};
