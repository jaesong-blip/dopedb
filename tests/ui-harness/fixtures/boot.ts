// 모든 장면이 공유하는 app boot IPC 응답. 장면은 이 위에 override만 얹는다.
// 부팅 시 무조건 호출되는 command 9개를 여기서 소유해, 새 boot command가
// 생기면 한 곳만 고치면 되도록 한다.
import type { HarnessIpcMap } from "../runtime/commandRouter";
import {
  localWorkspace,
  signedOutAuthState,
  workspaceFeatureDisabled,
} from "./identities";
import { bundledDrivers } from "./connections";
import { skillsUpToDate } from "./skills";

/** 부팅 경로에서 반드시 응답해야 하는 command 이름. */
export const BOOT_COMMANDS = [
  "get_active_workspace",
  "list_connections",
  "list_drivers",
  "list_workspaces",
  "plugin:updater|check",
  "refresh_workspace_auth_state",
  "skill_status",
  "workspace_auth_state",
  "workspace_feature_state",
] as const;

export function bootIpc(overrides: HarnessIpcMap = {}): HarnessIpcMap {
  return {
    list_connections: [],
    list_drivers: bundledDrivers,
    skill_status: skillsUpToDate,
    workspace_feature_state: workspaceFeatureDisabled,
    list_workspaces: [localWorkspace],
    get_active_workspace: localWorkspace,
    workspace_auth_state: signedOutAuthState,
    refresh_workspace_auth_state: signedOutAuthState,
    // null = 사용 가능한 업데이트 없음. plugin-updater의 check()가 null을 그대로 받는다.
    "plugin:updater|check": null,
    ...overrides,
  };
}
