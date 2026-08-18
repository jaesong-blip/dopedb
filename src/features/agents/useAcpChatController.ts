// The ACP tool-window controller owns session selection, focus generations,
// asynchronous commands, external queries, composer state, and viewport effects.
// Its return value is grouped by view responsibility so rendering modules do not
// receive a single flat bag of unrelated state and callbacks.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { CatalogTable } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import { createFrameCoalescer } from "../../lib/frameCoalescer";
import { useI18n } from "../../lib/i18n";
import { useCatalogScope } from "../../lib/queries";
import type { ConnectionProfile } from "../connections/domain";
import { knowledgeQueryKeys } from "../knowledge/queryKeys";
import {
  openAgentSetup,
  useEnabledAgentProviders,
} from "../skills/agentPreferences";
import type { WorkbenchDocument } from "../workbench/domain";
import {
  buildAcpPromptContext,
  summarizeAcpPromptContext,
} from "./acpPromptContext";
import {
  loginCommand,
  providerLabel,
  selectRichTranscriptKeys,
} from "./acpTranscriptPresentation";
import { useAgentDebugDetails } from "./displayPreferences";
import type {
  AcpPromptContext,
  AcpSessionConfigOption,
  AcpSessionFocus,
  AcpSessionId,
  AcpSessionLifecycle,
  AgentComposerRequest,
  AgentProvider,
} from "./domain";
import {
  AGENT_DOCK_DEFAULT_WIDTH,
  agentDockLayout,
  clampAgentDockWidth,
} from "./layout";
import {
  agentCliDetectionQuery,
  agentPluginStatusQuery,
} from "./queryOptions";
import { useAgentSelection } from "./selectionContext";
import {
  isCurrentAcpFocusRequest,
  type AcpFocusRequest,
} from "./sessionFocus";
import {
  recordAcpSessionFocus,
  retryAcpSessionSnapshot,
  useAcpSessionSnapshot,
} from "./sessionStore";
import {
  beginAgentInitializationOutcome,
  observeAgentTurnOutcome,
} from "./productAnalytics";
import {
  cancelAgentAcpSession,
  closeAgentAcpSession,
  focusAgentAcpSession,
  listAgentKnowledgeEnvironments,
  promptAgentAcpSession,
  respondAgentAcpPermission,
  resumeAgentAcpSession,
  setAgentAcpConfigOption,
  startAgentAcpSession,
} from "./tauriAdapter";
import { visibleAcpTranscriptItems } from "./transcript";

const MAX_PROMPT_CHARS = 8 * 1024;
const AGENT_SETUP_URL: Record<AgentProvider, string> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
  codex: "https://help.openai.com/en/articles/11096431",
};
const AUTO_SCROLL_THRESHOLD_PX = 96;

export type AcpChatControllerInput = {
  connection: ConnectionProfile;
  composerRequest: AgentComposerRequest | null;
  documents: WorkbenchDocument[];
  activeDocumentId: string | null;
  selectedTable: CatalogTable | null;
  overlay: boolean;
  compact?: boolean;
  width: number;
  onWidthChange: (width: number) => void;
};

export function useAcpChatController({
  connection,
  composerRequest,
  documents,
  activeDocumentId,
  selectedTable,
  overlay,
  compact = false,
  width,
  onWidthChange,
}: AcpChatControllerInput) {
  const { t } = useI18n();
  const catalogScope = useCatalogScope();
  const sessionSnapshot = useAcpSessionSnapshot(catalogScope.key);
  const { selection } = useAgentSelection();
  const debugDetails = useAgentDebugDetails();
  const configuredProviders = useEnabledAgentProviders();
  const [activeId, setActiveId] = useState<AcpSessionId | null>(null);
  const [starting, setStarting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<AgentProvider>("claude");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<
    string | null
  >(null);
  const [includeEditorContext, setIncludeEditorContext] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [configChanging, setConfigChanging] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [permissionSubmitting, setPermissionSubmitting] = useState<
    string | null
  >(null);
  const [copiedSetupCommand, setCopiedSetupCommand] =
    useState<AgentProvider | null>(null);
  const activeIdRef = useRef<AcpSessionId | null>(null);
  const selectionGenerationRef = useRef(0);
  const focusRequestIdRef = useRef(0);
  const catalogScopeKeyRef = useRef(catalogScope.key);
  catalogScopeKeyRef.current = catalogScope.key;
  const transcriptRef = useRef<HTMLDivElement>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const previousActiveIdRef = useRef<AcpSessionId | null>(null);
  const consumedComposerRequestRef = useRef<string | null>(null);
  const cliStatusQuery = useQuery({
    ...agentCliDetectionQuery(),
    refetchOnWindowFocus: false,
  });
  const pluginStatusQuery = useQuery({
    ...agentPluginStatusQuery(),
    refetchOnWindowFocus: false,
  });
  const knowledgeEnvironmentsQuery = useQuery({
    queryKey: knowledgeQueryKeys.agentEnvironments(
      connection.id,
      catalogScope.key,
    ),
    queryFn: () => listAgentKnowledgeEnvironments(connection.id),
    refetchOnWindowFocus: false,
  });
  const availableKnowledgeEnvironments = useMemo(
    () => knowledgeEnvironmentsQuery.data ?? [],
    [knowledgeEnvironmentsQuery.data],
  );
  const enabledProviders = useMemo(
    () =>
      configuredProviders.filter((provider) => {
        const pluginId = `dopedb.acp.${provider}`;
        const plugin = pluginStatusQuery.data?.find(
          (status) => status.pluginId === pluginId,
        );
        return (
          plugin?.enabled === true &&
          (plugin.installedVersion !== null ||
            plugin.candidateVersion !== null ||
            plugin.lastKnownGoodVersion !== null)
        );
      }),
    [configuredProviders, pluginStatusQuery.data],
  );

  const connectionSessions = useMemo(
    () =>
      sessionSnapshot.sessions
        .filter((session) => session.connectionId === connection.id)
        .filter((session) => enabledProviders.includes(session.provider))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [connection.id, enabledProviders, sessionSnapshot.sessions],
  );
  const active =
    connectionSessions.find((session) => session.id === activeId) ?? null;
  const activeSessionId = active?.id ?? null;
  const activeProvider = active?.provider ?? null;
  const activeEventsLoaded =
    activeSessionId !== null &&
    sessionSnapshot.projections.has(activeSessionId);
  const activeProjection = activeSessionId
    ? sessionSnapshot.projections.get(activeSessionId)
    : undefined;
  // Conversation projections append chunks in place and publish a revisioned
  // store snapshot. Derive these bounded views on render so neither can retain
  // a stale mutable projection behind an incomplete memo dependency.
  const transcript = visibleAcpTranscriptItems(activeProjection);
  const richTranscriptKeys = selectRichTranscriptKeys(transcript);
  const configOptions = activeProjection?.configOptions ?? [];
  const modelOption = configOptions.find(
    (option) =>
      option.category === "model" &&
      option.type === "select" &&
      typeof option.currentValue === "string",
  );
  const activeDocument =
    documents.find((document) => document.id === activeDocumentId) ?? null;
  const context = useMemo(
    () =>
      buildAcpPromptContext(
        connection,
        activeDocument,
        selectedTable,
        selection,
      ),
    [activeDocument, connection, selectedTable, selection],
  );
  const contextLabels = useMemo(
    () => summarizeAcpPromptContext(context),
    [context],
  );
  const pendingPermissionId =
    active?.lifecycle === "waitingPermission"
      ? activeProjection?.pendingPermissionId ?? null
      : null;
  const agentBusy =
    starting ||
    active?.lifecycle === "starting" ||
    active?.lifecycle === "running" ||
    active?.lifecycle === "waitingPermission";
  const selectedCliStatus =
    cliStatusQuery.data?.find((cli) => cli.id === selectedProvider) ?? null;
  const selectedCliReady =
    selectedCliStatus?.installed === true &&
    selectedCliStatus.authenticated === true;
  const cliDetectionError = cliStatusQuery.isError
    ? errMessage(cliStatusQuery.error)
    : selectedCliStatus?.detectionError ?? null;
  const selectedPluginReady = enabledProviders.includes(selectedProvider);
  const prerequisitesReady = selectedCliReady && selectedPluginReady;
  const selectedKnowledgeEnvironment = knowledgeEnvironmentsQuery.data?.find(
    (environment) => environment.id === selectedEnvironmentId,
  );
  const newEnvironmentScopeReady =
    selectedKnowledgeEnvironment !== undefined;
  const activeEnvironmentScopeReady =
    active !== null &&
    active.lifecycle !== "closed" &&
    active.lifecycle !== "failed";
  const environmentScopeReady =
    activeEnvironmentScopeReady || newEnvironmentScopeReady;
  const loading = sessionSnapshot.loading;
  const sessionLoadError = sessionSnapshot.error
    ? t("agent.acpLoadFailed", {
        error: errMessage(sessionSnapshot.error),
      })
    : null;
  const environmentLoadError = knowledgeEnvironmentsQuery.isError
    ? errMessage(knowledgeEnvironmentsQuery.error)
    : null;

  const selectActiveSession = useCallback((next: AcpSessionId | null) => {
    if (activeIdRef.current === next) return;
    activeIdRef.current = next;
    selectionGenerationRef.current += 1;
    setActiveId(next);
  }, []);
  const beginFocusRequest = useCallback(
    (): AcpFocusRequest => ({
      requestId: ++focusRequestIdRef.current,
      scopeKey: catalogScopeKeyRef.current,
      selectionGeneration: selectionGenerationRef.current,
      selectedSessionId: activeIdRef.current,
    }),
    [],
  );
  const focusRequestIsCurrent = useCallback(
    (request: AcpFocusRequest) =>
      isCurrentAcpFocusRequest(request, {
        requestId: focusRequestIdRef.current,
        scopeKey: catalogScopeKeyRef.current,
        selectionGeneration: selectionGenerationRef.current,
        selectedSessionId: activeIdRef.current,
      }),
    [],
  );
  const recordFocus = useCallback(
    (focus: AcpSessionFocus) =>
      recordAcpSessionFocus(catalogScope.key, focus),
    [catalogScope.key],
  );
  const loadFocusReplay = useCallback(
    async (sessionId: AcpSessionId) => {
      const focus = await focusAgentAcpSession(sessionId);
      // A late replay still belongs in the external store, but selection is
      // owned by the user's latest intent and is never changed by this read.
      recordFocus(focus);
      return focus;
    },
    [recordFocus],
  );
  const changeProvider = useCallback(
    (provider: AgentProvider) => {
      if (provider === selectedProvider && activeProvider === provider) return;
      setSelectedProvider(provider);
      setCopiedSetupCommand(null);
      if (activeProvider !== null && activeProvider !== provider) {
        selectActiveSession(null);
        setPrompt("");
        setError(null);
        setHistoryOpen(false);
        setIncludeEditorContext(false);
      }
    },
    [activeProvider, selectActiveSession, selectedProvider],
  );

  useEffect(() => {
    if (sessionSnapshot.loading) return;
    const next = sessionSnapshot.sessions
      .filter((session) => session.connectionId === connection.id)
      .filter((session) => isLiveSession(session.lifecycle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (activeIdRef.current === null) {
      selectActiveSession(next?.id ?? null);
    }
  }, [connection.id, selectActiveSession, sessionSnapshot, t]);

  useEffect(() => {
    selectActiveSession(null);
  }, [catalogScope.key, selectActiveSession]);

  useEffect(() => {
    const next =
      connectionSessions.find((session) =>
        isLiveSession(session.lifecycle)
      )?.id ?? null;
    if (
      activeId &&
      !connectionSessions.some((session) => session.id === activeId)
    ) {
      selectActiveSession(next);
    }
  }, [activeId, connectionSessions, selectActiveSession]);

  useEffect(() => {
    if (activeProvider) setSelectedProvider(activeProvider);
  }, [activeProvider]);

  useEffect(() => {
    if (active?.projectEnvironmentId) {
      setSelectedEnvironmentId(active.projectEnvironmentId);
      return;
    }
    if (composerRequest?.connectionId === connection.id) {
      setSelectedEnvironmentId(composerRequest.projectEnvironmentId);
      return;
    }
    setSelectedEnvironmentId(
      availableKnowledgeEnvironments.length === 1
        ? availableKnowledgeEnvironments[0].id
        : null,
    );
  }, [
    active?.id,
    active?.projectEnvironmentId,
    availableKnowledgeEnvironments,
    composerRequest,
    connection.id,
  ]);

  useEffect(() => {
    if (
      composerRequest === null ||
      composerRequest.connectionId !== connection.id ||
      consumedComposerRequestRef.current === composerRequest.id ||
      !knowledgeEnvironmentsQuery.isSuccess
    ) {
      return;
    }
    consumedComposerRequestRef.current = composerRequest.id;
    const environment = availableKnowledgeEnvironments.find(
      (candidate) => candidate.id === composerRequest.projectEnvironmentId,
    );
    if (!environment) {
      setError(t("agent.acpEnvironmentRequiredBody"));
      return;
    }
    if (active?.projectEnvironmentId !== environment.id) {
      selectActiveSession(null);
    }
    setSelectedEnvironmentId(environment.id);
    setPrompt(composerRequest.prompt.slice(0, MAX_PROMPT_CHARS));
    setHistoryOpen(false);
    setError(null);
    setComposerExpanded(false);
    setIncludeEditorContext(false);
  }, [
    active?.projectEnvironmentId,
    availableKnowledgeEnvironments,
    composerRequest,
    connection.id,
    knowledgeEnvironmentsQuery.isSuccess,
    selectActiveSession,
    t,
  ]);

  useEffect(() => {
    if (enabledProviders.includes(selectedProvider)) return;
    const next = enabledProviders[0];
    if (next) void changeProvider(next);
  }, [changeProvider, enabledProviders, selectedProvider]);

  useEffect(() => {
    if (activeSessionId === null || activeEventsLoaded) return;
    const request = beginFocusRequest();
    void loadFocusReplay(activeSessionId).catch((reason) => {
      if (!focusRequestIsCurrent(request)) return;
      setError(t("agent.acpLoadFailed", { error: errMessage(reason) }));
    });
    return () => {
      if (focusRequestIdRef.current === request.requestId) {
        focusRequestIdRef.current += 1;
      }
    };
  }, [
    activeEventsLoaded,
    activeSessionId,
    beginFocusRequest,
    focusRequestIsCurrent,
    loadFocusReplay,
    t,
  ]);

  useEffect(() => {
    if (previousActiveIdRef.current !== active?.id) {
      previousActiveIdRef.current = active?.id ?? null;
      stickToBottomRef.current = true;
    }
    if (!stickToBottomRef.current || autoScrollFrameRef.current !== null) return;
    autoScrollFrameRef.current = window.requestAnimationFrame(() => {
      autoScrollFrameRef.current = null;
      const element = transcriptRef.current;
      if (!element || !stickToBottomRef.current) return;
      element.scrollTop = element.scrollHeight;
    });
  }, [active?.id, activeProjection?.revision]);

  useEffect(
    () => () => {
      if (autoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
      }
    },
    [],
  );

  const updateAutoScroll = useCallback(() => {
    const element = transcriptRef.current;
    if (!element) return;
    stickToBottomRef.current =
      element.scrollHeight - element.clientHeight - element.scrollTop <=
      AUTO_SCROLL_THRESHOLD_PX;
  }, []);

  async function startSession(provider = selectedProvider) {
    const environmentId = selectedEnvironmentId;
    if (
      starting ||
      !prerequisitesReady ||
      !newEnvironmentScopeReady ||
      environmentId === null
    ) {
      return null;
    }
    const request = beginFocusRequest();
    const completeAnalytics = beginAgentInitializationOutcome(
      catalogScope,
      provider,
    );
    setStarting(true);
    setError(null);
    try {
      const focus = await startAgentAcpSession(
        connection.id,
        provider,
        environmentId,
      );
      completeAnalytics("success");
      const recorded = recordFocus(focus);
      if (!recorded || !focusRequestIsCurrent(request)) return null;
      selectActiveSession(focus.session.id);
      setSelectedProvider(provider);
      setHistoryOpen(false);
      return focus;
    } catch (reason) {
      completeAnalytics("failed");
      if (!focusRequestIsCurrent(request)) return null;
      setError(
        t("agent.acpStartFailed", {
          provider: providerLabel(provider),
          error: errMessage(reason),
        }),
      );
      return null;
    } finally {
      setStarting(false);
    }
  }

  function beginNewChat() {
    if (starting) return;
    selectActiveSession(null);
    setHistoryOpen(false);
    setPrompt("");
    setError(null);
    setComposerExpanded(false);
    setIncludeEditorContext(false);
  }

  function selectSession(id: AcpSessionId) {
    const session = connectionSessions.find((candidate) => candidate.id === id);
    selectActiveSession(id);
    setError(null);
    if (session) setSelectedProvider(session.provider);
    setHistoryOpen(false);
  }

  async function resumeSession() {
    if (!active || starting || active.acpSessionId === null) return;
    const request = beginFocusRequest();
    const completeAnalytics = beginAgentInitializationOutcome(
      catalogScope,
      active.provider,
    );
    setStarting(true);
    setError(null);
    try {
      const focus = await resumeAgentAcpSession(active.id);
      completeAnalytics("success");
      recordFocus(focus);
    } catch (reason) {
      completeAnalytics("failed");
      if (!focusRequestIsCurrent(request)) return;
      setError(t("agent.acpResumeFailed", { error: errMessage(reason) }));
      try {
        const recoveryRequest = beginFocusRequest();
        await loadFocusReplay(active.id);
        if (!focusRequestIsCurrent(recoveryRequest)) return;
      } catch {
        // Keep the actionable resume error when the persisted focus also vanished.
      }
    } finally {
      setStarting(false);
    }
  }

  async function sendPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (starting || !prompt.trim()) return;
    if (!prerequisitesReady || !environmentScopeReady) return;
    const submitted = prompt;
    setError(null);
    try {
      let session = active;
      if (
        !session ||
        session.lifecycle === "closed" ||
        session.lifecycle === "failed"
      ) {
        const focus = await startSession(selectedProvider);
        session = focus?.session ?? null;
      }
      if (!session || session.lifecycle !== "ready") return;
      const submittedContext: AcpPromptContext = includeEditorContext
        ? buildAcpPromptContext(
            connection,
            activeDocument,
            selectedTable,
            selection,
          )
        : {
            database: null,
            documentName: null,
            documentText: null,
            table: null,
          };
      const stopObservingTurn = observeAgentTurnOutcome(
        catalogScope,
        session.id,
        session.provider,
      );
      try {
        await promptAgentAcpSession(session.id, submitted, submittedContext);
      } catch (reason) {
        stopObservingTurn?.();
        throw reason;
      }
      setPrompt("");
    } catch (reason) {
      setError(t("agent.acpSendFailed", { error: errMessage(reason) }));
    }
  }

  async function openSetupGuide(provider: AgentProvider) {
    setError(null);
    try {
      await openUrl(AGENT_SETUP_URL[provider]);
    } catch (reason) {
      setError(t("agent.acpSetupActionFailed", { error: errMessage(reason) }));
    }
  }

  async function copyLoginCommand(provider: AgentProvider) {
    setError(null);
    try {
      await navigator.clipboard.writeText(loginCommand(provider));
      setCopiedSetupCommand(provider);
    } catch (reason) {
      setError(t("agent.acpSetupActionFailed", { error: errMessage(reason) }));
    }
  }

  async function changeConfigOption(
    option: AcpSessionConfigOption,
    value: string,
  ) {
    if (!active || configChanging || option.currentValue === value) return;
    setConfigChanging(option.id);
    setError(null);
    try {
      await setAgentAcpConfigOption(active.id, option.id, value);
    } catch (reason) {
      setError(
        t("agent.acpConfigFailed", {
          name: option.name,
          error: errMessage(reason),
        }),
      );
    } finally {
      setConfigChanging(null);
    }
  }

  const respondPermission = useCallback(
    async (requestId: string, optionId: string | null) => {
      if (!activeId || permissionSubmitting) return;
      setPermissionSubmitting(requestId);
      setError(null);
      try {
        await respondAgentAcpPermission(activeId, requestId, optionId);
      } catch (reason) {
        setError(t("agent.acpPermissionFailed", { error: errMessage(reason) }));
      } finally {
        setPermissionSubmitting(null);
      }
    },
    [activeId, permissionSubmitting, t],
  );

  async function cancelTurn() {
    if (!active) return;
    setError(null);
    try {
      await cancelAgentAcpSession(active.id);
      // The live ACP event stream owns the turn-end and ready transition.
      // Replaying focus here races that stream and can merge an incomplete frame.
    } catch (reason) {
      setError(t("agent.acpCancelFailed", { error: errMessage(reason) }));
    }
  }

  async function closeSession() {
    if (!active || active.lifecycle === "closed") return;
    setError(null);
    try {
      await closeAgentAcpSession(active.id);
    } catch (reason) {
      setError(t("agent.acpCloseFailed", { error: errMessage(reason) }));
    }
  }

  function beginResize(event: ReactMouseEvent<HTMLDivElement>) {
    if (overlay || compact) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const widthAt = (clientX: number) =>
      clampAgentDockWidth(
        startWidth + startX - clientX,
        window.innerWidth,
      );
    const coalescer = createFrameCoalescer<number>(onWidthChange);
    const move = (next: MouseEvent) => {
      coalescer.push(widthAt(next.clientX));
    };
    const up = (next: MouseEvent) => {
      coalescer.push(widthAt(next.clientX));
      coalescer.flush();
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  const openMessageLink = useCallback((href: string) => {
    void openUrl(href).catch(() => undefined);
  }, []);

  return {
    viewport: {
      layout: agentDockLayout(compact, overlay),
      transcriptRef,
      onTranscriptScroll: updateAutoScroll,
      resize: {
        onMouseDown: beginResize,
        onDoubleClick: () => onWidthChange(AGENT_DOCK_DEFAULT_WIDTH),
      },
    },
    session: {
      active,
      sessions: connectionSessions,
      transcript,
      richTranscriptKeys,
      activeEventsLoaded,
      replayTruncated: activeProjection?.replayTruncated ?? false,
      pendingPermissionId,
      permissionSubmitting,
      historyOpen,
      starting,
      busy: agentBusy,
      loading,
      loadError: sessionLoadError,
      debugDetails,
    },
    setup: {
      selectedProvider,
      enabledProviders,
      selectedCliStatus,
      selectedCliReady,
      selectedPluginReady,
      prerequisitesReady,
      cliDetectionError,
      cliPending: cliStatusQuery.isPending,
      cliFetching: cliStatusQuery.isFetching,
      pluginPending: pluginStatusQuery.isPending,
      copiedSetupCommand,
      knowledge: {
        environments: availableKnowledgeEnvironments,
        selectedEnvironmentId,
        pending: knowledgeEnvironmentsQuery.isPending,
        success: knowledgeEnvironmentsQuery.isSuccess,
        loadError: environmentLoadError,
        newScopeReady: newEnvironmentScopeReady,
      },
    },
    composer: {
      prompt,
      maxPromptChars: MAX_PROMPT_CHARS,
      expanded: composerExpanded,
      includeEditorContext,
      contextLabels,
      environmentScopeReady,
      modelOption,
      configChanging,
    },
    feedback: {
      error,
    },
    commands: {
      session: {
        beginNewChat,
        select: selectSession,
        resume: resumeSession,
        start: startSession,
        cancelTurn,
        close: closeSession,
        toggleHistory: () => setHistoryOpen((current) => !current),
        retryLoad: () => retryAcpSessionSnapshot(catalogScope.key),
      },
      composer: {
        submit: sendPrompt,
        setPrompt,
        toggleExpanded: () => setComposerExpanded((current) => !current),
        toggleEditorContext: () =>
          setIncludeEditorContext((current) => !current),
        selectEnvironment: setSelectedEnvironmentId,
        changeConfigOption,
      },
      setup: {
        changeProvider,
        openAgentSetup,
        openSetupGuide,
        copyLoginCommand,
        refreshCli: () => cliStatusQuery.refetch(),
        refreshKnowledgeEnvironments: () =>
          knowledgeEnvironmentsQuery.refetch(),
      },
      permission: {
        respond: respondPermission,
      },
      feedback: {
        dismiss: () => setError(null),
      },
      links: {
        openMessage: openMessageLink,
      },
    },
  };
}

export type AcpChatController = ReturnType<typeof useAcpChatController>;

function isLiveSession(lifecycle: AcpSessionLifecycle) {
  return (
    lifecycle === "starting" ||
    lifecycle === "ready" ||
    lifecycle === "running" ||
    lifecycle === "waitingPermission"
  );
}
