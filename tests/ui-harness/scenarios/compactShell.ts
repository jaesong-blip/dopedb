// Tier 0 — 900×680 compact viewport. Explorer와 main이 유효한 데이터 공간을
// 유지하는지 검사하며 560px drawer 전환은 별도 interaction 계약에서 검증한다.
import { analyticsPostgres } from "../fixtures/connections";
import { connectedIpc, connectedStorage, CONNECTED_COMMANDS, ALL_RUBRIC, shellLayout, SHELL_ROLES } from "./common";
import type { UiHarnessScenario } from "./types";

export const compactShell: UiHarnessScenario = {
  id: "compact-shell",
  title: "Compact shell — 900×680",
  viewport: "compact",
  activeArea: "workspace",
  selectedConnectionId: analyticsPostgres.id,
  initialStorage: connectedStorage(),
  ipc: connectedIpc(),
  benchmark: {
    referenceId: "DopeDB-2026.1-explorer-macos",
    referenceCloneScene: "first-run",
    requiredRegions: ["rail", "explorer", "workbench"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: CONNECTED_COMMANDS,
    visibleRoles: SHELL_ROLES,
    layout: shellLayout(false, 260),
  },
};
