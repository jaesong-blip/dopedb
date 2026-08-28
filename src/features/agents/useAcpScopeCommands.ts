// Context changes replace only a prepared, empty ACP session. Once a turn has
// started, the immutable Project resource set is intentionally locked.

import type { Dispatch, SetStateAction } from "react";

import { errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type { ConnectionId } from "../connections/domain";
import type { AcpSessionId, AcpSessionSummary } from "./domain";
import { closeAgentAcpSession } from "./tauriAdapter";

export function useAcpScopeCommands({
  active,
  scopeChangeAllowed,
  starting,
  onSelectSession,
  setError,
  setStarting,
  toggleResource,
  selectWriteTarget,
}: {
  active: AcpSessionSummary | null;
  scopeChangeAllowed: boolean;
  starting: boolean;
  onSelectSession: (id: AcpSessionId | null) => void;
  setError: Dispatch<SetStateAction<string | null>>;
  setStarting: Dispatch<SetStateAction<boolean>>;
  toggleResource: (resourceKey: string) => void;
  selectWriteTarget: (connectionId: ConnectionId | null) => void;
}) {
  const { t } = useI18n();

  async function replacePreparedSession(action: () => void) {
    if (starting || !scopeChangeAllowed) return;
    if (active) {
      setStarting(true);
      setError(null);
      try {
        await closeAgentAcpSession(active.id);
        onSelectSession(null);
      } catch (reason) {
        setError(t("agent.acpCloseFailed", { error: errMessage(reason) }));
        setStarting(false);
        return;
      }
    }
    action();
    if (active) setStarting(false);
  }

  return {
    toggle(resourceKey: string | null) {
      if (resourceKey === null) return Promise.resolve();
      return replacePreparedSession(() => toggleResource(resourceKey));
    },
    write(connectionId: ConnectionId | null) {
      return replacePreparedSession(() => selectWriteTarget(connectionId));
    },
  };
}
