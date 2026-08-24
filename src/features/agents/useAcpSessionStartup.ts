// This hook owns one in-flight ACP startup and prewarms a new exact-scope
// session without letting an earlier scope or selection claim its result.

import { useCallback, useEffect, useRef } from "react";

import { errMessage } from "../../ipc/types";
import type { CatalogScope } from "../../lib/queries";
import { useI18n } from "../../lib/i18n";
import type { ConnectionId } from "../connections/domain";
import { providerLabel } from "./acpTranscriptPresentation";
import type {
  AcpSessionFocus,
  AgentProvider,
} from "./domain";
import {
  ownsStartedAcpSession,
  type AcpFocusRequest,
} from "./sessionFocus";
import { beginAgentInitializationOutcome } from "./productAnalytics";
import { recordAcpSessionFocus } from "./sessionStore";
import { startAgentAcpSession } from "./tauriAdapter";

type AcpSessionStartupInput = {
  activeSessionId: string | null;
  beginFocusRequest: () => AcpFocusRequest;
  catalogScope: CatalogScope;
  connectionId: ConnectionId;
  currentFocusRequest: () => AcpFocusRequest;
  environmentScopeReady: boolean;
  focusRequestIsCurrent: (request: AcpFocusRequest) => boolean;
  onError: (message: string | null) => void;
  onStarted: (focus: AcpSessionFocus, provider: AgentProvider) => void;
  onStartingChange: (starting: boolean) => void;
  prerequisitesReady: boolean;
  selectedEnvironmentId: string | null;
  selectedProvider: AgentProvider;
  sessionsLoading: boolean;
};

export function useAcpSessionStartup({
  activeSessionId,
  beginFocusRequest,
  catalogScope,
  connectionId,
  currentFocusRequest,
  environmentScopeReady,
  focusRequestIsCurrent,
  onError,
  onStarted,
  onStartingChange,
  prerequisitesReady,
  selectedEnvironmentId,
  selectedProvider,
  sessionsLoading,
}: AcpSessionStartupInput) {
  const { t } = useI18n();
  const pendingStartRef = useRef<{
    key: string;
    promise: Promise<AcpSessionFocus | null>;
  } | null>(null);
  const prewarmAttemptRef = useRef<string | null>(null);

  const startSession = useCallback(
    (provider = selectedProvider): Promise<AcpSessionFocus | null> => {
      const environmentId = selectedEnvironmentId;
      if (
        !prerequisitesReady ||
        !environmentScopeReady ||
        environmentId === null
      ) {
        return Promise.resolve(null);
      }
      const startKey = [
        catalogScope.key,
        connectionId,
        provider,
        environmentId,
      ].join(":");
      if (pendingStartRef.current?.key === startKey) {
        return pendingStartRef.current.promise;
      }
      const request = beginFocusRequest();
      const completeAnalytics = beginAgentInitializationOutcome(
        catalogScope,
        provider,
      );
      const pending = (async () => {
        onStartingChange(true);
        onError(null);
        try {
          const focus = await startAgentAcpSession(
            connectionId,
            provider,
            environmentId,
          );
          completeAnalytics("success");
          const recorded = recordAcpSessionFocus(catalogScope.key, focus);
          if (
            !recorded ||
            !ownsStartedAcpSession(
              request,
              currentFocusRequest(),
              focus.session.id,
            )
          ) {
            return null;
          }
          onStarted(focus, provider);
          return focus;
        } catch (reason) {
          completeAnalytics("failed");
          if (!focusRequestIsCurrent(request)) return null;
          onError(
            t("agent.acpStartFailed", {
              provider: providerLabel(provider),
              error: errMessage(reason),
            }),
          );
          return null;
        }
      })();
      pendingStartRef.current = { key: startKey, promise: pending };
      void pending.finally(() => {
        if (pendingStartRef.current?.promise !== pending) return;
        pendingStartRef.current = null;
        onStartingChange(false);
      });
      return pending;
    },
    [
      beginFocusRequest,
      catalogScope,
      connectionId,
      currentFocusRequest,
      environmentScopeReady,
      focusRequestIsCurrent,
      onError,
      onStarted,
      onStartingChange,
      prerequisitesReady,
      selectedEnvironmentId,
      selectedProvider,
      t,
    ],
  );

  useEffect(() => {
    const selectedSessionId = currentFocusRequest().selectedSessionId;
    if (activeSessionId !== null || selectedSessionId !== null) {
      prewarmAttemptRef.current = null;
      return;
    }
    if (
      sessionsLoading ||
      !prerequisitesReady ||
      !environmentScopeReady ||
      selectedEnvironmentId === null
    ) {
      return;
    }
    const prewarmKey = [
      catalogScope.key,
      connectionId,
      selectedProvider,
      selectedEnvironmentId,
    ].join(":");
    if (prewarmAttemptRef.current === prewarmKey) return;
    prewarmAttemptRef.current = prewarmKey;
    void startSession(selectedProvider);
  }, [
    activeSessionId,
    catalogScope.key,
    connectionId,
    currentFocusRequest,
    environmentScopeReady,
    prerequisitesReady,
    selectedEnvironmentId,
    selectedProvider,
    sessionsLoading,
    startSession,
  ]);

  return startSession;
}
