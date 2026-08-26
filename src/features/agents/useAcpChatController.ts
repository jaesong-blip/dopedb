// ACP Chat owns session selection, lifecycle, permissions, composer state, and
// viewport effects while returning state grouped by view responsibility.

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
  promptAgentAcpSession,
  respondAgentAcpPermission,
  resumeAgentAcpSession,
  setAgentAcpConfigOption,
} from "./tauriAdapter";
import { visibleAcpTranscriptItems } from "./transcript";
import { useAgentEnvironmentInventory } from "./useAgentEnvironmentInventory";
import {
  useAgentScopeConnection,
  useAgentScopeSelection,
} from "./useAgentScopeSelection";
import { useAcpSessionStartup } from "./useAcpSessionStartup";

const MAX_PROMPT_CHARS = 8 * 1024;
const AGENT_SETUP_URL: Record<AgentProvider, string> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
  codex: "https://help.openai.com/en/articles/11096431",
};
const AUTO_SCROLL_THRESHOLD_PX = 96;
const EMPTY_PROMPT_CONTEXT: AcpPromptContext = {
  database: null,
  documentName: null,
  documentText: null,
  table: null,
};

export type AcpChatControllerInput = {
  connection: ConnectionProfile;
  connections: ConnectionProfile[];
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
  connections,
  composerRequest,
  documents,
  activeDocumentId,
  selectedTable,
  overlay,
  compact = false,
  width,
  onWidthChange,
}: AcpChatControllerInput) {
  const { lang, t } = useI18n();
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
  const scopeConnection = useAgentScopeConnection(connection, connections);
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
  const environmentInventory = useAgentEnvironmentInventory({
    catalogScopeKey: catalogScope.key,
    connection: scopeConnection.connection,
    onError: setError,
  });
  const availableKnowledgeEnvironments = environmentInventory.available;
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
        .filter((session) => session.connectionId === scopeConnection.connection.id)
        .filter((session) => enabledProviders.includes(session.provider))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [enabledProviders, scopeConnection.connection.id, sessionSnapshot.sessions],
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
  const scopeChangeAllowed = active === null || (active.lifecycle === "ready" && transcript.length === 0);
  const agentScope = useAgentScopeSelection({
    active,
    composerRequest,
    connectionId: scopeConnection.connection.id,
    inventory: environmentInventory,
    onClearError: () => setError(null),
    onSelectConnection: scopeConnection.select,
    selectionLocked: !scopeChangeAllowed,
  });
  const { environmentId: selectedEnvironmentId, rememberSessionScope } = agentScope;
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
        scopeConnection.connection,
        activeDocument,
        selectedTable,
        selection,
      ),
    [activeDocument, scopeConnection.connection, selectedTable, selection],
  );
  const contextLabels = useMemo(() => summarizeAcpPromptContext(context), [context]);
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
  const newEnvironmentScopeReady = agentScope.newScopeReady;
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
  const environmentLoadError = environmentInventory.loadError;

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
  const currentFocusRequest = useCallback(
    (): AcpFocusRequest => ({
      requestId: focusRequestIdRef.current,
      scopeKey: catalogScopeKeyRef.current,
      selectionGeneration: selectionGenerationRef.current,
      selectedSessionId: activeIdRef.current,
    }),
    [],
  );
  const focusRequestIsCurrent = useCallback(
    (request: AcpFocusRequest) =>
      isCurrentAcpFocusRequest(request, currentFocusRequest()),
    [currentFocusRequest],
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
      .filter((session) => session.connectionId === scopeConnection.connection.id)
      .filter((session) => isLiveSession(session.lifecycle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (activeIdRef.current === null) {
      selectActiveSession(next?.id ?? null);
    }
  }, [scopeConnection.connection.id, selectActiveSession, sessionSnapshot, t]);

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

  const commitStartedSession = useCallback(
    (focus: AcpSessionFocus, provider: AgentProvider) => {
      rememberSessionScope(focus.session.id);
      selectActiveSession(focus.session.id);
      setSelectedProvider(provider);
      setHistoryOpen(false);
    },
    [rememberSessionScope, selectActiveSession],
  );
  const startSession = useAcpSessionStartup({
    activeSessionId: activeId,
    beginFocusRequest,
    catalogScope,
    connectionId: scopeConnection.connection.id,
    currentFocusRequest,
    environmentScopeReady: newEnvironmentScopeReady,
    focusRequestIsCurrent,
    onError: setError,
    onStarted: commitStartedSession,
    onStartingChange: setStarting,
    prerequisitesReady,
    selectedEnvironmentConnectionIds: agentScope.environmentConnectionIds,
    selectedEnvironmentId,
    selectedProvider,
    sessionsLoading: sessionSnapshot.loading,
  });

  const submitPromptText = useCallback(
    async (submitted: string, submittedContext: AcpPromptContext) => {
      if (starting || !submitted.trim()) return false;
      if (!prerequisitesReady || !environmentScopeReady) return false;
      let session = active;
      if (
        !session ||
        session.lifecycle === "closed" ||
        session.lifecycle === "failed"
      ) {
        const focus = await startSession(selectedProvider);
        session = focus?.session ?? null;
      }
      if (!session || session.lifecycle !== "ready") return false;
      const stopObservingTurn = observeAgentTurnOutcome(
        catalogScope,
        session.id,
        session.provider,
      );
      try {
        await promptAgentAcpSession(session.id, submitted, {
          ...submittedContext, responseLanguage: lang,
        });
      } catch (reason) {
        stopObservingTurn?.();
        throw reason;
      }
      return true;
    }, [
      active,
      catalogScope,
      environmentScopeReady, lang,
      prerequisitesReady,
      selectedProvider,
      startSession,
      starting,
    ],
  );

  useEffect(() => {
    if (
      composerRequest === null ||
      composerRequest.connectionId !== scopeConnection.connection.id ||
      consumedComposerRequestRef.current === composerRequest.id ||
      !environmentInventory.success
    ) return;
    const environment = availableKnowledgeEnvironments.find(
      (candidate) => candidate.id === composerRequest.projectEnvironmentId,
    );
    if (!environment) {
      consumedComposerRequestRef.current = composerRequest.id;
      setError(t("agent.acpEnvironmentRequiredBody"));
      return;
    }
    if (selectedEnvironmentId !== environment.id) return;
    if (active?.projectEnvironmentId && active.projectEnvironmentId !== environment.id) {
      selectActiveSession(null);
      return;
    }
    if (
      starting ||
      !prerequisitesReady ||
      (active !== null && !["ready", "closed", "failed"].includes(active.lifecycle))
    ) return;
    consumedComposerRequestRef.current = composerRequest.id;
    const submitted = composerRequest.prompt.slice(0, MAX_PROMPT_CHARS);
    setPrompt(submitted);
    setHistoryOpen(false);
    setError(null);
    setComposerExpanded(false);
    setIncludeEditorContext(false);
    void submitPromptText(submitted, EMPTY_PROMPT_CONTEXT)
      .then((sent) => {
        if (sent) setPrompt("");
      })
      .catch((reason) => {
        setError(t("agent.acpSendFailed", { error: errMessage(reason) }));
      });
  }, [
    active,
    availableKnowledgeEnvironments,
    composerRequest,
    scopeConnection.connection.id,
    environmentInventory.success,
    prerequisitesReady,
    selectActiveSession,
    selectedEnvironmentId,
    starting,
    submitPromptText,
    t,
  ]);

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
    const submitted = prompt;
    setError(null);
    try {
      const submittedContext: AcpPromptContext = includeEditorContext
        ? buildAcpPromptContext(
            scopeConnection.connection,
            activeDocument,
            selectedTable,
            selection,
          )
        : EMPTY_PROMPT_CONTEXT;
      if (await submitPromptText(submitted, submittedContext)) setPrompt("");
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

  async function selectAgentScope(scopeKey: string | null) {
    if (starting || !scopeChangeAllowed) return;
    if (active) {
      setStarting(true);
      setError(null);
      try {
        await closeAgentAcpSession(active.id);
        selectActiveSession(null);
      } catch (reason) {
        setError(t("agent.acpCloseFailed", { error: errMessage(reason) }));
        setStarting(false);
        return;
      }
    }
    await agentScope.select(scopeKey);
    if (active) setStarting(false);
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
        projectScopes: environmentInventory.projectScopes,
        databaseScopes: environmentInventory.databaseScopes,
        selectedEnvironmentId,
        selectedScopeKey: agentScope.selectedScopeKey,
        scopeChangeAllowed,
        pending: environmentInventory.pending,
        success: environmentInventory.success,
        loadError: environmentLoadError,
        newScopeReady: newEnvironmentScopeReady,
        reconfirmingEnvironmentId: environmentInventory.updatingEnvironmentId,
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
        selectEnvironment: selectAgentScope,
        changeConfigOption,
      },
      setup: {
        changeProvider,
        openAgentSetup,
        openSetupGuide,
        copyLoginCommand,
        refreshCli: () => cliStatusQuery.refetch(),
        refreshKnowledgeEnvironments: () =>
          environmentInventory.refresh(),
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
