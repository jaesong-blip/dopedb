import { invoke } from "@tauri-apps/api/core";

import {
  parseQueryServiceSession,
  type QueryServiceSession,
} from "./domain";

export type QueryServiceStorageScope = {
  workspaceId: string;
  accountScope: string;
};

export async function listQueryServiceSessions(
  scope: QueryServiceStorageScope,
) {
  const sessions = await invoke<unknown[]>("list_query_service_sessions", {
    expectedWorkspaceId: scope.workspaceId,
    expectedAccountScope: scope.accountScope,
  });
  return sessions.map(parseQueryServiceSession);
}

export function saveQueryServiceSession(
  scope: QueryServiceStorageScope,
  session: QueryServiceSession,
) {
  return invoke<void>("save_query_service_session", {
    expectedWorkspaceId: scope.workspaceId,
    expectedAccountScope: scope.accountScope,
    session,
  });
}
