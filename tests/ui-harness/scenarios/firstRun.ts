// Tier 0 — 연결이 하나도 없는 최초 실행. DopeDB first-run 화면과 비교하는 장면이다.
// 저장 상태를 비워 두어 제품의 실제 최초 실행 경로를 그대로 통과시킨다.
import { bootIpc, BOOT_COMMANDS } from "../fixtures/boot";
import { ENGLISH_HARNESS_STORAGE } from "../runtime/storage";
import { ALL_RUBRIC, shellLayout, SHELL_ROLES } from "./common";
import type { UiHarnessScenario } from "./types";

export const firstRun: UiHarnessScenario = {
  id: "first-run",
  title: "최초 실행 — 연결 없음",
  viewport: "desktop",
  activeArea: "workspace",
  selectedConnectionId: null,
  initialStorage: ENGLISH_HARNESS_STORAGE,
  ipc: bootIpc(),
  benchmark: {
    referenceId: "DopeDB-2026.1-first-run-macos",
    referenceCloneScene: "first-run",
    requiredRegions: ["rail", "explorer", "workbench"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: BOOT_COMMANDS,
    visibleRoles: [
      ...SHELL_ROLES,
      { role: "heading", name: "Welcome to DopeDB" },
    ],
    layout: shellLayout(),
  },
};
