// Tier 2 — connection inventory가 실패한 실제 inline recovery surface. handler는
// 빈 배열로 숨기지 않고 typed fixture error를 반환한다.
import { bootIpc, BOOT_COMMANDS } from "../fixtures/boot";
import { ENGLISH_HARNESS_STORAGE } from "../runtime/storage";
import { ALL_RUBRIC, shellLayout, SHELL_ROLES } from "./common";
import type { UiHarnessScenario } from "./types";

export const loadingError: UiHarnessScenario = {
  id: "loading-error",
  title: "Connection inventory failure",
  viewport: "desktop",
  activeArea: "workspace",
  selectedConnectionId: null,
  initialStorage: ENGLISH_HARNESS_STORAGE,
  ipc: bootIpc({
    list_connections: () => {
      throw {
        kind: "io",
        message: "Fixture connection inventory unavailable",
      };
    },
  }),
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
      { role: "alert" },
      { role: "button", name: "Retry" },
    ],
    layout: shellLayout(),
  },
};
