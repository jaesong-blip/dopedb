// Tier 1 — 실제 Settings shell과 Agent Tools inventory를 렌더한다. 설치/삭제는
// 실행하지 않고 read-only 상태 command만 fixture로 제공한다.
import { analyticsPostgres } from "../fixtures/connections";
import {
  detectedAgentClis,
  legacyCleanupAbsent,
} from "../fixtures/settings";
import {
  ALL_RUBRIC,
  connectedIpc,
  connectedStorage,
  expectedCommands,
  shellLayout,
  SHELL_ROLES,
} from "./common";
import type { UiHarnessScenario } from "./types";

export const settings: UiHarnessScenario = {
  id: "settings",
  title: "Settings — Agent Tools",
  viewport: "desktop",
  activeArea: "settings",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage(),
  ipc: connectedIpc({
    detect_agent_clis: detectedAgentClis,
    legacy_mcp_cleanup_status: legacyCleanupAbsent,
  }),
  benchmark: {
    referenceId: "DopeDB-2026.1-first-run-macos",
    referenceCloneScene: "first-run",
    requiredRegions: ["rail", "explorer", "workbench"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: expectedCommands(
      "detect_agent_clis",
      "get_catalog_overview",
      "get_safety",
      "legacy_mcp_cleanup_status",
      "list_sql_documents",
    ),
    visibleRoles: [
      ...SHELL_ROLES,
      { role: "heading", name: "Agent tools" },
    ],
    layout: shellLayout(),
  },
};
