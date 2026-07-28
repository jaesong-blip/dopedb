// Tier 2 — signed-in account menu에서 device-local provider credential dialog를
// 연다. 첫 begin은 실패하고 같은 명시 action의 retry는 성공하도록 고정한다.
import { bootIpc } from "../fixtures/boot";
import { signedInAuthState } from "../fixtures/identities";
import {
  gcpIntegration,
  providerIntegrations,
  readyGcpBinding,
} from "../fixtures/providers";
import { ENGLISH_HARNESS_STORAGE } from "../runtime/storage";
import {
  ALL_RUBRIC,
  expectedCommands,
  shellLayout,
  SHELL_ROLES,
} from "./common";
import type { HarnessCommandHandler } from "../runtime/commandRouter";
import type { UiHarnessScenario } from "./types";

let beginAttempts = 0;
const beginBinding: HarnessCommandHandler = () => {
  beginAttempts += 1;
  if (beginAttempts % 2 === 1) {
    throw {
      kind: "provider",
      message: "Fixture provider is temporarily unavailable",
    };
  }
  return {
    receiptId: "f5f5f5f5-5555-4555-8555-555555555555",
    expiresAt: "2026-07-28T09:10:00.000Z",
  };
};

export const providerSetup: UiHarnessScenario = {
  id: "provider-setup",
  title: "Provider credentials — failure and retry",
  viewport: "desktop",
  activeArea: "workspace",
  selectedConnectionId: null,
  initialStorage: ENGLISH_HARNESS_STORAGE,
  ipc: bootIpc({
    workspace_auth_state: signedInAuthState,
    refresh_workspace_auth_state: signedInAuthState,
    list_provider_integrations: providerIntegrations,
    list_provider_credential_bindings: [],
    begin_provider_credential_binding: beginBinding,
    verify_provider_credential_binding: readyGcpBinding,
  }),
  benchmark: {
    referenceId: "DopeDB-2026.1-assistant-macos",
    referenceCloneScene: "assistant-open",
    requiredRegions: ["rail", "explorer", "workbench"],
    rubric: ALL_RUBRIC,
  },
  expected: {
    commands: expectedCommands(
      "list_provider_credential_bindings",
      "list_provider_integrations",
    ),
    visibleRoles: [
      ...SHELL_ROLES,
      { role: "dialog", name: "Provider credentials" },
      {
        role: "button",
        name: `${gcpIntegration.displayName} gcpCloudSql Credentials required`,
      },
    ],
    layout: shellLayout(),
    focusOrder: ["account", "menu", "dialog", "return"],
  },
};
