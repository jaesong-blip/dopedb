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
  AgentResourceScopeSelection,
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
  resourceScopeReady: boolean;
  ensureSelectedResources: () => Promise<boolean>;
  focusRequestIsCurrent: (request: AcpFocusRequest) => boolean;
  onError: (message: string | null) => void;
  onStarted: (focus: AcpSessionFocus, provider: AgentProvider) => void;
  onStartingChange: (starting: boolean) => void;
  prerequisitesReady: boolean;
  selectedResourceScopes: AgentResourceScopeSelection[];
  writeConnectionId: ConnectionId | null;
  selectedProvider: AgentProvider;
  sessionsLoading: boolean;
};

export function useAcpSessionStartup({
  activeSessionId,
  beginFocusRequest,
  catalogScope,
  connectionId,
  currentFocusRequest,
  resourceScopeReady,
  ensureSelectedResources,
  focusRequestIsCurrent,
  onError,
  onStarted,
  onStartingChange,
  prerequisitesReady,
  selectedResourceScopes,
  writeConnectionId,
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
      if (
        !prerequisitesReady ||
        !resourceScopeReady ||
        selectedResourceScopes.length === 0
      ) {
        return Promise.resolve(null);
      }
      const startKey = [
        catalogScope.key,
        connectionId,
        provider,
        JSON.stringify(selectedResourceScopes),
        writeConnectionId ?? "read-only",
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
          if (!(await ensureSelectedResources())) {
            completeAnalytics("failed");
            return null;
          }
          const focus = await startAgentAcpSession(
            connectionId,
            provider,
            selectedResourceScopes,
            writeConnectionId,
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
      ensureSelectedResources,
      focusRequestIsCurrent,
      onError,
      onStarted,
      onStartingChange,
      prerequisitesReady,
      resourceScopeReady,
      selectedResourceScopes,
      selectedProvider,
      t,
      writeConnectionId,
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
      !resourceScopeReady ||
      selectedResourceScopes.length === 0
    ) {
      return;
    }
    const prewarmKey = [
      catalogScope.key,
      connectionId,
      selectedProvider,
      JSON.stringify(selectedResourceScopes),
      writeConnectionId ?? "read-only",
    ].join(":");
    if (prewarmAttemptRef.current === prewarmKey) return;
    prewarmAttemptRef.current = prewarmKey;
    const timeout = window.setTimeout(() => {
      void startSession(selectedProvider);
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [
    activeSessionId,
    catalogScope.key,
    connectionId,
    currentFocusRequest,
    resourceScopeReady,
    prerequisitesReady,
    selectedResourceScopes,
    selectedProvider,
    sessionsLoading,
    startSession,
    writeConnectionId,
  ]);

  return startSession;
}
