// Tier 2 — 저장된 exact DELETE를 실제 SQL 화면의 ApprovalCard까지 진행한다.
// 승인/거절은 durable operation id와 payload hash를 strict router로 검증한다.
import {
  analyticsCatalog,
  writeReviewSafety,
} from "../fixtures/catalogs";
import { analyticsPostgres } from "../fixtures/connections";
import {
  permissionProposal,
  permissionSqlDocument,
} from "../fixtures/queries";
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

export const permissionReview: UiHarnessScenario = {
  id: "permission-review",
  title: "Exact operation permission review",
  viewport: "desktop",
  activeArea: "workspace",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage({
    [HARNESS_STORAGE_KEYS.tab]: "sql",
  }),
  ipc: connectedIpc({
    get_safety: writeReviewSafety,
    get_schema: JSON.stringify(analyticsCatalog),
    list_sql_documents: [permissionSqlDocument],
    propose_sql: permissionProposal,
    reject_operation: {
      operationId: permissionProposal.operationId,
      payloadHash: permissionProposal.payloadHash,
      state: "rejected",
    },
  }),
  benchmark: {
    referenceId: "DopeDB-2026.1-assistant-macos",
    referenceCloneScene: "assistant-open",
    requiredRegions: ["rail", "explorer", "workbench"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: expectedCommands(
      "get_safety",
      "get_schema",
      "list_sql_documents",
      "propose_sql",
    ),
    visibleRoles: [
      ...SHELL_ROLES,
      { role: "button", name: "Reject" },
    ],
    layout: shellLayout(),
  },
};
