// Scenario 공통 계약. 제품 저장 key, boot command와 benchmark rubric을 한 곳에서
// 조합해 장면 파일에는 해당 장면의 차이만 남긴다.
import { bootIpc, BOOT_COMMANDS } from "../fixtures/boot";
import { analyticsOverview, readOnlySafety } from "../fixtures/catalogs";
import { analyticsPostgres, stagingPostgres } from "../fixtures/connections";
import {
  ENGLISH_HARNESS_STORAGE,
  HARNESS_STORAGE_KEYS,
} from "../runtime/storage";
import type { HarnessIpcMap } from "../runtime/commandRouter";
import type {
  BenchmarkCriterionId,
  UiHarnessScenario,
} from "./types";

export const ALL_RUBRIC = [
  "orientation",
  "workbenchHierarchy",
  "densityAndAlignment",
  "actionLocality",
  "contextContinuity",
  "accessibility",
] as const satisfies readonly BenchmarkCriterionId[];

export const CONNECTED_COMMANDS = [
  ...BOOT_COMMANDS,
  "get_catalog_overview",
  "get_safety",
  "list_sql_documents",
].sort();

export function expectedCommands(...extra: string[]): string[] {
  return [...new Set([...BOOT_COMMANDS, ...extra])].sort();
}

export function connectedIpc(overrides: HarnessIpcMap = {}): HarnessIpcMap {
  return bootIpc({
    list_connections: [analyticsPostgres, stagingPostgres],
    get_safety: readOnlySafety,
    get_catalog_overview: analyticsOverview,
    list_sql_documents: [],
    ...overrides,
  });
}

export function connectedStorage(
  overrides: Readonly<Record<string, string>> = {},
) {
  return {
    ...ENGLISH_HARNESS_STORAGE,
    [HARNESS_STORAGE_KEYS.selectedId]: analyticsPostgres.id,
    [HARNESS_STORAGE_KEYS.terminalDockOpen]: "0",
    ...overrides,
  };
}

export function shellLayout(
  terminalVisible = false,
  minimumMainWidth = 320,
): UiHarnessScenario["expected"]["layout"] {
  return {
    viewportFits: true,
    maxVisualDepth: 3,
    minimumMainWidth,
    terminalVisible,
  };
}

export const SHELL_ROLES = [
  { role: "navigation", count: 1 },
  { role: "menubar", count: 1 },
  { role: "main", count: 1 },
] as const satisfies UiHarnessScenario["expected"]["visibleRoles"];
