import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Icon } from "../../components/Icon";
import ToolbarMenu, {
  ToolbarMenuItem,
} from "../../components/ToolbarMenu";
import {
  AgentActivityLine,
  AgentPermissionCard,
  AgentProviderMark,
  AgentToolCallCard,
} from "../../design-system/components/Agent";
import {
  AgentRichText,
  AgentStreamingText,
} from "../../design-system/components/AgentRichText";
import { Button } from "../../design-system/components/Button";
import {
  InlineNotice,
  LoadingLabel,
  StatusDot,
  type StatusTone,
} from "../../design-system/components/Status";
import {
  ToolWindowComposer,
  ToolWindowComposerContext,
  ToolWindowComposerDock,
  ToolWindowComposerInput,
  ToolWindowHeader,
  ToolWindowHideButton,
} from "../../design-system/components/ToolWindow";
import {
  errMessage,
  type CatalogTable,
} from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import { createFrameCoalescer } from "../../lib/frameCoalescer";
import type { ConnectionProfile } from "../connections/domain";
import type { WorkbenchDocument } from "../workbench/domain";
import { readWorkbenchDraft } from "../workbench/draftStore";
import type {
  AcpPermissionOption,
  AcpPromptContext,
  AcpSessionConfigOption,
  AcpSessionEvent,
  AcpSessionId,
  AcpSessionLifecycle,
  AcpSessionSummary,
  AgentCliInfo,
  AgentProvider,
} from "./domain";
import {
  AGENT_DOCK_DEFAULT_WIDTH,
  clampAgentDockWidth,
} from "./layout";
import AcpStructuredResult from "./AcpStructuredResult";
import { agentCliDetectionQuery } from "./queryOptions";
import {
  openAgentSetup,
  useEnabledAgentProviders,
} from "../skills/agentPreferences";
import { useAgentSelection } from "./selectionContext";
import { useAgentDebugDetails } from "./displayPreferences";
import {
  cancelAgentAcpSession,
  closeAgentAcpSession,
  focusAgentAcpSession,
  listAgentAcpSessions,
  onAgentAcpChanged,
  promptAgentAcpSession,
  respondAgentAcpPermission,
  resumeAgentAcpSession,
  setAgentAcpConfigOption,
  startAgentAcpSession,
} from "./tauriAdapter";
import {
  appendAcpConversationEvents,
  mergeAcpConversationFocus,
  visibleAcpTranscriptItems,
  type AcpConversationProjection,
  type AcpTranscriptItem,
} from "./transcript";

// Four-byte Unicode remains within the Rust byte limits.
const MAX_DOCUMENT_CONTEXT_CHARS = 16 * 1024;
const MAX_PROMPT_CHARS = 8 * 1024;
const AGENT_SETUP_URL: Record<AgentProvider, string> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
  codex: "https://help.openai.com/en/articles/11096431",
};
const AUTO_SCROLL_THRESHOLD_PX = 96;

type PendingAcpSessionChange = {
  session: AcpSessionSummary;
  events: AcpSessionEvent[];
};

export default function AcpChatPanel({
  connection,
  documents,
  activeDocumentId,
  selectedTable,
  overlay,
  compact = false,
  width,
  onWidthChange,
  onOpenArchive,
  onClose,
}: {
  connection: ConnectionProfile;
  documents: WorkbenchDocument[];
  activeDocumentId: string | null;
  selectedTable: CatalogTable | null;
  overlay: boolean;
  compact?: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onOpenArchive: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { selection } = useAgentSelection();
  const debugDetails = useAgentDebugDetails();
  const enabledProviders = useEnabledAgentProviders();
  const [sessions, setSessions] = useState<AcpSessionSummary[]>([]);
  const [activeId, setActiveId] = useState<AcpSessionId | null>(null);
  const projectionsRef = useRef(new Map<string, AcpConversationProjection>());
  const [projectionRevision, setProjectionRevision] = useState(0);
  const pendingChangesRef = useRef(
    new Map<string, PendingAcpSessionChange>(),
  );
  const pendingChangeFrameRef = useRef<number | null>(null);
  const pendingChangeTimerRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<AgentProvider>("claude");
  const [includeEditorContext, setIncludeEditorContext] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [configChanging, setConfigChanging] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [permissionSubmitting, setPermissionSubmitting] = useState<string | null>(
    null,
  );
  const [copiedSetupCommand, setCopiedSetupCommand] =
    useState<AgentProvider | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const previousActiveIdRef = useRef<AcpSessionId | null>(null);
  const cliStatusQuery = useQuery({
    ...agentCliDetectionQuery(),
    refetchOnWindowFocus: false,
  });

  const connectionSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.connectionId === connection.id)
        .filter((session) => enabledProviders.includes(session.provider))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [connection.id, enabledProviders, sessions],
  );
  const active =
    connectionSessions.find((session) => session.id === activeId) ?? null;
  const activeEventsLoaded =
    active !== null &&
    projectionsRef.current.has(active.id);
  const activeProjection = active
    ? projectionsRef.current.get(active.id)
    : undefined;
  const transcript = useMemo(
    () => visibleAcpTranscriptItems(activeProjection),
    [active?.id, projectionRevision],
  );
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
      promptContext(
        connection,
        activeDocument,
        selectedTable,
        selection,
      ),
    [activeDocument, connection, selectedTable, selection],
  );
  const contextLabels = useMemo(() => contextSummary(context), [context]);
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
  const prerequisitesReady = selectedCliReady;
  const dockLayout = compact ? "compact" : overlay ? "overlay" : "docked";

  const upsertSessions = useCallback((updates: AcpSessionSummary[]) => {
    if (updates.length === 0) return;
    setSessions((current) => {
      const byId = new Map(current.map((session) => [session.id, session]));
      let changed = false;
      for (const update of updates) {
        const previous = byId.get(update.id);
        if (previous && previous.updatedAt > update.updatedAt) continue;
        if (previous !== update) changed = true;
        byId.set(update.id, update);
      }
      return changed ? [...byId.values()] : current;
    });
  }, []);

  const applyFocus = useCallback(
    (focus: {
      session: AcpSessionSummary;
      events: AcpSessionEvent[];
      replayTruncated: boolean;
    }) => {
      upsertSessions([focus.session]);
      const current = projectionsRef.current.get(focus.session.id);
      projectionsRef.current.set(
        focus.session.id,
        mergeAcpConversationFocus(
          current,
          focus.events,
          focus.replayTruncated,
        ),
      );
      setProjectionRevision((revision) => revision + 1);
      setActiveId(focus.session.id);
    },
    [upsertSessions],
  );

  const flushPendingChanges = useCallback(() => {
    if (pendingChangeFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingChangeFrameRef.current);
    }
    if (pendingChangeTimerRef.current !== null) {
      window.clearTimeout(pendingChangeTimerRef.current);
    }
    pendingChangeFrameRef.current = null;
    pendingChangeTimerRef.current = null;
    const pending = pendingChangesRef.current;
    pendingChangesRef.current = new Map();
    if (pending.size === 0) return;
    upsertSessions([...pending.values()].map((change) => change.session));
    let projectionChanged = false;
    for (const [sessionId, change] of pending) {
      if (change.events.length === 0) continue;
      const result = appendAcpConversationEvents(
        projectionsRef.current.get(sessionId),
        change.events,
      );
      projectionsRef.current.set(sessionId, result.projection);
      projectionChanged ||= result.changed;
    }
    if (projectionChanged) {
      setProjectionRevision((revision) => revision + 1);
    }
  }, [upsertSessions]);

  const queueSessionChange = useCallback(
    (session: AcpSessionSummary, event: AcpSessionEvent | null) => {
      const pending = pendingChangesRef.current.get(session.id);
      if (pending) {
        pending.session = session;
        if (event) pending.events.push(event);
      } else {
        pendingChangesRef.current.set(session.id, {
          session,
          events: event ? [event] : [],
        });
      }
      if (pendingChangeFrameRef.current === null) {
        pendingChangeFrameRef.current = window.requestAnimationFrame(
          flushPendingChanges,
        );
        pendingChangeTimerRef.current = window.setTimeout(
          flushPendingChanges,
          50,
        );
      }
      if (uiProjectionBoundary(event)) flushPendingChanges();
    },
    [flushPendingChanges],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    setLoading(true);
    setError(null);

    void Promise.all([
      listAgentAcpSessions(),
      onAgentAcpChanged((change) => {
        if (disposed) return;
        queueSessionChange(change.session, change.event);
        if (
          change.session.connectionId === connection.id &&
          change.session.lifecycle === "starting"
        ) {
          setActiveId((current) => current ?? change.session.id);
        }
      }),
    ])
      .then(([loaded, stopListening]) => {
        if (disposed) {
          stopListening();
          return;
        }
        unlisten = stopListening;
        upsertSessions(loaded);
        const next = loaded
          .filter((session) => session.connectionId === connection.id)
          .filter((session) => isLiveSession(session.lifecycle))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        setActiveId(next?.id ?? null);
      })
      .catch((reason) => {
        if (!disposed) setError(t("agent.acpLoadFailed", { error: errMessage(reason) }));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
      if (pendingChangeFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingChangeFrameRef.current);
        pendingChangeFrameRef.current = null;
      }
      if (pendingChangeTimerRef.current !== null) {
        window.clearTimeout(pendingChangeTimerRef.current);
        pendingChangeTimerRef.current = null;
      }
      pendingChangesRef.current.clear();
      unlisten?.();
    };
  }, [connection.id, queueSessionChange, t, upsertSessions]);

  useEffect(() => {
    const next =
      connectionSessions.find((session) =>
        isLiveSession(session.lifecycle)
      )?.id ?? null;
    if (
      activeId &&
      !connectionSessions.some((session) => session.id === activeId)
    ) {
      setActiveId(next);
    }
  }, [activeId, connectionSessions]);

  useEffect(() => {
    if (active) setSelectedProvider(active.provider);
  }, [active]);

  useEffect(() => {
    if (enabledProviders.includes(selectedProvider)) return;
    const next = enabledProviders[0];
    if (next) void changeProvider(next);
  }, [enabledProviders, selectedProvider]);

  useEffect(() => {
    if (!active || activeEventsLoaded) return;
    void focusAgentAcpSession(active.id)
      .then(applyFocus)
      .catch((reason) =>
        setError(t("agent.acpLoadFailed", { error: errMessage(reason) }))
      );
  }, [active?.id, activeEventsLoaded, applyFocus, t]);

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
  }, [active?.id, projectionRevision]);

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
    if (starting || !prerequisitesReady) return null;
    setStarting(true);
    setError(null);
    try {
      const focus = await startAgentAcpSession(connection.id, provider);
      applyFocus(focus);
      setSelectedProvider(provider);
      setHistoryOpen(false);
      return focus;
    } catch (reason) {
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
    setActiveId(null);
    setHistoryOpen(false);
    setPrompt("");
    setError(null);
    setComposerExpanded(false);
    setIncludeEditorContext(false);
  }

  async function selectSession(id: AcpSessionId) {
    setActiveId(id);
    setError(null);
    try {
      const focus = await focusAgentAcpSession(id);
      applyFocus(focus);
      setSelectedProvider(focus.session.provider);
      setHistoryOpen(false);
    } catch (reason) {
      setError(t("agent.acpLoadFailed", { error: errMessage(reason) }));
    }
  }

  async function resumeSession() {
    if (!active || starting || active.acpSessionId === null) return;
    setStarting(true);
    setError(null);
    try {
      applyFocus(await resumeAgentAcpSession(active.id));
    } catch (reason) {
      setError(t("agent.acpResumeFailed", { error: errMessage(reason) }));
      try {
        applyFocus(await focusAgentAcpSession(active.id));
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
    if (!prerequisitesReady) return;
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
      const submittedContext = includeEditorContext
        ? promptContext(
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
      await promptAgentAcpSession(session.id, submitted, submittedContext);
      setPrompt("");
    } catch (reason) {
      setError(t("agent.acpSendFailed", { error: errMessage(reason) }));
    }
  }

  async function changeProvider(provider: AgentProvider) {
    if (provider === selectedProvider && active?.provider === provider) return;
    setSelectedProvider(provider);
    setCopiedSetupCommand(null);
    if (active && active.provider !== provider) {
      setActiveId(null);
      setPrompt("");
      setError(null);
      setHistoryOpen(false);
      setIncludeEditorContext(false);
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
      applyFocus(await focusAgentAcpSession(active.id));
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

  return (
    <aside
      className="tw:relative tw:col-start-4 tw:row-start-2 tw:mt-0 tw:mr-1 tw:mb-1 tw:ml-0 tw:flex tw:min-w-0 tw:flex-col tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-background tw:data-[layout=overlay]:fixed tw:data-[layout=overlay]:inset-y-0 tw:data-[layout=overlay]:right-0 tw:data-[layout=overlay]:z-[var(--ds-z-modal)] tw:data-[layout=overlay]:m-0 tw:data-[layout=overlay]:w-[min(520px,calc(100vw_-_44px))] tw:data-[layout=overlay]:rounded-none tw:data-[layout=overlay]:shadow-popover tw:data-[layout=compact]:fixed tw:data-[layout=compact]:top-title-toolbar tw:data-[layout=compact]:right-0 tw:data-[layout=compact]:bottom-status-bar tw:data-[layout=compact]:left-0 tw:data-[layout=compact]:z-[var(--ds-z-modal)] tw:data-[layout=compact]:m-0 tw:data-[layout=compact]:w-screen tw:data-[layout=compact]:rounded-none tw:data-[layout=compact]:border-x-0"
      data-layout={dockLayout}
      aria-label={t("agent.acpTitle")}
      role={dockLayout === "docked" ? undefined : "dialog"}
      aria-modal={dockLayout === "docked" ? undefined : true}
    >
      <div
        className="tw:absolute tw:inset-y-0 tw:-left-[3px] tw:z-[var(--ds-z-raised)] tw:w-[7px] tw:cursor-col-resize tw:hover:bg-ring/30 tw:active:bg-ring/30 tw:data-[layout=overlay]:hidden tw:data-[layout=compact]:hidden"
        data-layout={dockLayout}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("app.dragResize")}
        onMouseDown={beginResize}
        onDoubleClick={() => onWidthChange(AGENT_DOCK_DEFAULT_WIDTH)}
      />
      <ToolWindowHeader
        title={t("agent.acpTitle")}
        divider={false}
        actions={
          <>
            <Button
              size="compact"
              variant="ghost"
              disabled={starting}
              onClick={beginNewChat}
              title={t("agent.acpNew")}
            >
              <Icon name="plus" />
              {t("agent.acpNew")}
            </Button>
            <Button
              iconOnly
              size="xs"
              variant="ghost"
              aria-pressed={historyOpen}
              onClick={() => setHistoryOpen((current) => !current)}
              title={t("agent.acpSessions")}
              aria-label={t("agent.acpSessions")}
            >
              <Icon name="history" />
            </Button>
            <ToolbarMenu
              align="end"
              icon="moreVertical"
              label={t("agent.acpMore")}
            >
              <ToolbarMenuItem icon="gear" onClick={openAgentSetup}>
                {t("agent.acpAgentSetup")}
              </ToolbarMenuItem>
              <ToolbarMenuItem icon="history" onClick={onOpenArchive}>
                {t("agent.acpArchive")}
              </ToolbarMenuItem>
              {active &&
              active.lifecycle !== "closed" &&
              active.lifecycle !== "failed" ? (
                <ToolbarMenuItem
                  icon="trash"
                  onClick={() => void closeSession()}
                >
                  {t("agent.acpCloseSession")}
                </ToolbarMenuItem>
              ) : null}
            </ToolbarMenu>
            <ToolWindowHideButton
              label={t("common.close")}
              onClick={onClose}
            />
          </>
        }
      />

      {agentBusy ? (
        <div
          className="tw:mx-6 tw:mt-2 tw:h-2 tw:shrink-0 tw:overflow-hidden tw:rounded-pill tw:bg-muted"
          role="progressbar"
          aria-label={t("agent.acpWorking")}
        >
          <span className="tw:block tw:h-full tw:w-full tw:animate-pulse tw:rounded-pill tw:bg-muted-foreground/30 tw:motion-reduce:animate-none" />
        </div>
      ) : null}

      {error ? (
        <InlineNotice
          tone="danger"
          icon="alert"
          role="alert"
          action={
            <Button
              iconOnly
              size="xs"
              variant="ghost"
              onClick={() => setError(null)}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <Icon name="close" />
            </Button>
          }
        >
          {error}
        </InlineNotice>
      ) : null}

      {historyOpen ? (
        <section className="tw:grid tw:max-h-[min(360px,45vh)] tw:shrink-0 tw:overflow-auto tw:border-b tw:border-border-subtle tw:bg-background tw:p-1">
          {connectionSessions.length > 0 ? (
            connectionSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className="tw:flex tw:min-h-control-lg tw:min-w-0 tw:items-center tw:gap-2 tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-2 tw:text-left tw:text-sm tw:text-foreground tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground"
                data-active={session.id === active?.id}
                onClick={() => void selectSession(session.id)}
              >
                <Icon name="database" />
                <span className="tw:min-w-0 tw:flex-1 tw:truncate">
                  {session.title}
                </span>
                <span className="tw:text-xs tw:text-muted-foreground">
                  {providerLabel(session.provider)}
                </span>
                <StatusDot tone={lifecycleTone(session.lifecycle)} />
                <span className="tw:sr-only">
                  {lifecycleLabel(session.lifecycle, t)}
                </span>
              </button>
            ))
          ) : (
            <p className="tw:m-0 tw:px-2 tw:py-3 tw:text-xs tw:text-muted-foreground">
              {t("agent.acpNoSessions")}
            </p>
          )}
        </section>
      ) : null}

      <div
        ref={transcriptRef}
        className="tw:min-h-0 tw:min-w-0 tw:flex-1 tw:overflow-x-hidden tw:overflow-y-auto tw:overscroll-contain tw:bg-background tw:px-6 tw:pt-10 tw:pb-5"
        aria-live="polite"
        onScroll={updateAutoScroll}
      >
        {loading ||
        cliStatusQuery.isPending ||
        (active && !activeEventsLoaded) ? (
          <AgentEmpty>
            <LoadingLabel>{t("common.loading")}</LoadingLabel>
          </AgentEmpty>
        ) : starting && !active ? (
          <AgentEmpty>
            <LoadingLabel>{t("agent.acpStarting")}</LoadingLabel>
          </AgentEmpty>
        ) : selectedCliStatus && !selectedCliReady ? (
          <AgentSetupGuidance
            cli={selectedCliStatus}
            copied={copiedSetupCommand === selectedProvider}
            checking={cliStatusQuery.isFetching}
            onPrimary={() =>
              void (selectedCliStatus.installed
                ? copyLoginCommand(selectedProvider)
                : openSetupGuide(selectedProvider))
            }
            onCheck={() => void cliStatusQuery.refetch()}
          />
        ) : !active ? (
          <AgentEmpty>
            <h2 className="tw:sr-only">{t("agent.acpEmptyTitle")}</h2>
            <ul className="tw:m-0 tw:grid tw:w-full tw:max-w-[18rem] tw:gap-3 tw:p-0 tw:text-left tw:list-none">
              <li>{t("agent.acpEmptyFeatureSql")}</li>
              <li>{t("agent.acpEmptyFeatureInspect")}</li>
              <li>{t("agent.acpEmptyFeatureApprove")}</li>
            </ul>
          </AgentEmpty>
        ) : transcript.length === 0 ? (
          <AgentEmpty>
            {active.lifecycle === "starting" ? (
              <LoadingLabel>{t("agent.acpStarting")}</LoadingLabel>
            ) : active.lifecycle === "failed" ? (
              <>
                <Icon name="alert" />
                <strong>{t("agent.acpFailed")}</strong>
                <p>{active.error}</p>
              </>
            ) : (
              <>
                <Icon name="database" />
                <strong>{t("agent.acpReadyTitle")}</strong>
                <p>{t("agent.acpReadyBody")}</p>
              </>
            )}
          </AgentEmpty>
        ) : (
          <div className="tw:grid tw:max-w-full tw:min-w-0 tw:gap-6 tw:overflow-hidden">
            {activeProjection?.replayTruncated ? (
              <div className="tw:flex tw:items-center tw:gap-2 tw:text-xs tw:leading-body tw:text-muted-foreground">
                <Icon name="history" />
                <span>{t("agent.acpReplayTruncated")}</span>
              </div>
            ) : null}
            {transcript.map((item, index) => (
              <Fragment key={item.key}>
                {showProviderHeading(transcript, index) ? (
                  <ProviderHeading provider={active.provider} />
                ) : null}
                <TranscriptItemView
                  item={item}
                  revision={item.revision}
                  debugDetails={debugDetails}
                  streaming={
                    active.lifecycle === "running" &&
                    item.kind === "agent" &&
                    index === transcript.length - 1
                  }
                  pendingPermissionId={pendingPermissionId}
                  permissionSubmitting={permissionSubmitting}
                  onPermission={respondPermission}
                />
              </Fragment>
            ))}
            {active.lifecycle === "running" ? (
              <div className="tw:flex tw:items-center tw:gap-2 tw:py-1 tw:text-xs tw:text-muted-foreground">
                <StatusDot tone="success" />
                {t("agent.acpWorking")}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <ToolWindowComposerDock>
        {active &&
        (active.lifecycle === "closed" || active.lifecycle === "failed") ? (
          <div className="tw:mb-2 tw:flex tw:min-h-control-lg tw:items-center tw:gap-3 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:px-3 tw:py-2">
            <p className="tw:m-0 tw:min-w-0 tw:flex-1 tw:text-xs tw:leading-body tw:text-muted-foreground">
              {active.acpSessionId === null
                ? t("agent.acpRestartBody")
                : t("agent.acpResumeBody")}
            </p>
            <Button
              size="compact"
              variant="primary"
              disabled={starting || !prerequisitesReady}
              onClick={() =>
                void (active.acpSessionId === null
                  ? startSession()
                  : resumeSession())
              }
            >
              <Icon
                name={starting ? "refresh" : "play"}
                data-loading={starting || undefined}
                className="tw:data-[loading=true]:animate-spin tw:motion-reduce:animate-none"
              />
              {active.acpSessionId === null
                ? t("agent.acpNew")
                : t("agent.acpResume")}
            </Button>
          </div>
        ) : null}
        <ToolWindowComposer
          aria-label={t("agent.acpComposer")}
          onSubmit={sendPrompt}
          expanded={composerExpanded}
          busy={agentBusy}
        >
          <ToolWindowComposerInput
            value={prompt}
            maxLength={MAX_PROMPT_CHARS}
            disabled={
              starting ||
              !prerequisitesReady ||
              (active !== null &&
                active.lifecycle !== "ready" &&
                active.lifecycle !== "closed" &&
                active.lifecycle !== "failed")
            }
            placeholder={
              agentBusy ? t("agent.acpWaiting") : t("agent.acpPrompt")
            }
            aria-label={t("agent.acpPrompt")}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <span className="tw:absolute tw:top-1.5 tw:right-1.5">
            <Button
              type="button"
              iconOnly
              size="xs"
              variant="ghost"
              onClick={() => setComposerExpanded((current) => !current)}
              title={
                composerExpanded
                  ? t("agent.acpCollapseComposer")
                  : t("agent.acpExpandComposer")
              }
              aria-label={
                composerExpanded
                  ? t("agent.acpCollapseComposer")
                  : t("agent.acpExpandComposer")
              }
            >
              <Icon name={composerExpanded ? "minimize" : "maximize"} />
            </Button>
          </span>
          {includeEditorContext && contextLabels.length > 0 ? (
            <div className="tw:flex tw:flex-wrap tw:gap-1 tw:px-2 tw:pb-1">
              {contextLabels.map((label) => (
                <span
                  key={label.text}
                  className="tw:inline-flex tw:h-control-sm tw:max-w-full tw:items-center tw:gap-1 tw:rounded-xs tw:bg-muted tw:px-2 tw:text-xs tw:text-foreground"
                  title={label.text}
                >
                  <Icon name={label.icon} />
                  <span className="tw:truncate">{label.text}</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="tw:flex tw:min-h-control-lg tw:items-center tw:gap-1 tw:px-2">
            {contextLabels.length > 0 ? (
              <Button
                type="button"
                iconOnly
                size="xs"
                variant="ghost"
                aria-pressed={includeEditorContext}
                onClick={() =>
                  setIncludeEditorContext((current) => !current)
                }
                title={
                  includeEditorContext
                    ? t("agent.acpDetachContext")
                    : t("agent.acpAttachContext")
                }
                aria-label={
                  includeEditorContext
                    ? t("agent.acpDetachContext")
                    : t("agent.acpAttachContext")
                }
              >
                <Icon name="plus" />
              </Button>
            ) : null}
            <span className="tw:flex-1" />
            {active?.lifecycle === "running" ||
            active?.lifecycle === "waitingPermission" ? (
              <Button
                iconOnly
                size="compact"
                variant="ghost"
                tone="danger"
                onClick={() => void cancelTurn()}
                title={t("agent.acpCancel")}
                aria-label={t("agent.acpCancel")}
              >
                <Icon name="stop" />
              </Button>
            ) : (
              <Button
                type="submit"
                iconOnly
                size="compact"
                variant="ghost"
                disabled={
                  starting ||
                  !prerequisitesReady ||
                  (active !== null &&
                    active.lifecycle !== "ready" &&
                    active.lifecycle !== "closed" &&
                    active.lifecycle !== "failed") ||
                  !prompt.trim()
                }
                title={t("agent.acpSend")}
                aria-label={t("agent.acpSend")}
              >
                <Icon name="send" />
              </Button>
            )}
          </div>
        </ToolWindowComposer>
        <ToolWindowComposerContext>
          <AgentProviderMark provider={selectedProvider} />
          <select
            className="tw:h-control-sm tw:max-w-[10rem] tw:cursor-pointer tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-1 tw:font-sans tw:text-ui tw:text-foreground tw:outline-none tw:hover:bg-muted tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
            value={selectedProvider}
            disabled={starting}
            onChange={(event) =>
              void changeProvider(event.target.value as AgentProvider)
            }
            aria-label={t("agent.acpProvider")}
            title={t("agent.acpLocalAuth")}
          >
            {enabledProviders.includes("claude") ? (
              <option value="claude">Claude Agent</option>
            ) : null}
            {enabledProviders.includes("codex") ? (
              <option value="codex">Codex</option>
            ) : null}
          </select>
          {modelOption ? (
            <ConfigSelect
              option={modelOption}
              changing={configChanging === modelOption.id}
              onChange={(value) => void changeConfigOption(modelOption, value)}
            />
          ) : null}
        </ToolWindowComposerContext>
      </ToolWindowComposerDock>
    </aside>
  );
}

function ConfigSelect({
  option,
  changing,
  onChange,
}: {
  option: AcpSessionConfigOption;
  changing: boolean;
  onChange: (value: string) => void;
}) {
  const options = flattenConfigSelectOptions(option);
  if (typeof option.currentValue !== "string" || options.length === 0) {
    return null;
  }
  return (
    <select
      className="tw:h-control-sm tw:max-w-[11rem] tw:cursor-pointer tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-1 tw:font-sans tw:text-xs tw:text-foreground tw:outline-none tw:hover:bg-muted tw:focus-visible:ring-2 tw:focus-visible:ring-ring tw:disabled:cursor-wait tw:disabled:text-muted-foreground"
      value={option.currentValue}
      disabled={changing}
      onChange={(event) => onChange(event.target.value)}
      aria-label={option.name}
      title={option.description ?? option.name}
    >
      {options.map((entry) => (
        <option key={entry.value} value={entry.value}>
          {entry.name}
        </option>
      ))}
    </select>
  );
}

function AgentEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="tw:m-auto tw:flex tw:min-h-full tw:w-[min(360px,calc(100%_-_var(--ds-space-6)))] tw:flex-col tw:items-center tw:justify-center tw:gap-3 tw:text-center tw:text-sm tw:text-muted-foreground tw:[&>.icon]:size-7 tw:[&>.icon]:text-foreground tw:[&>strong]:text-title tw:[&>strong]:text-foreground tw:[&>p]:m-0 tw:[&>p]:leading-body tw:[&>small]:max-w-[320px] tw:[&>small]:leading-body">
      {children}
    </div>
  );
}

function AgentSetupGuidance({
  cli,
  copied,
  checking,
  onPrimary,
  onCheck,
}: {
  cli: AgentCliInfo;
  copied: boolean;
  checking: boolean;
  onPrimary: () => void;
  onCheck: () => void;
}) {
  const { t } = useI18n();
  const provider = providerLabel(cli.id);
  return (
    <div className="tw:grid tw:gap-5">
      <ProviderHeading provider={cli.id} />
      <AgentPermissionCard
        title={t("agent.acpSetupTitle", { provider })}
        description={
          cli.installed
            ? t("agent.acpSetupLoginBody", {
                provider,
                command: loginCommand(cli.id),
              })
            : t("agent.acpSetupInstallBody", { provider })
        }
        pending
        status={t("agent.acpSetupRequired")}
        actions={
          <div className="tw:flex tw:flex-wrap tw:gap-2">
            <Button size="compact" variant="primary" onClick={onPrimary}>
              {cli.installed
                ? copied
                  ? t("agent.acpSetupCopied")
                  : t("agent.acpSetupCopyLogin")
                : t("agent.acpSetupOpenGuide")}
            </Button>
            <Button
              size="compact"
              variant="ghost"
              disabled={checking}
              onClick={onCheck}
            >
              <Icon
                name="refresh"
                data-loading={checking || undefined}
                className="tw:data-[loading=true]:animate-spin tw:motion-reduce:animate-none"
              />
              {t("agent.acpSetupCheckAgain")}
            </Button>
          </div>
        }
      />
      <p className="tw:m-0 tw:text-xs tw:leading-body tw:text-muted-foreground">
        {t("agent.acpSetupPrivacy")}
      </p>
    </div>
  );
}

function ProviderHeading({ provider }: { provider: AgentProvider }) {
  return (
    <div className="tw:flex tw:items-center tw:gap-2 tw:pt-1">
      <AgentProviderMark provider={provider} />
      <strong className="tw:text-sm tw:text-foreground">
        {providerLabel(provider)}
      </strong>
    </div>
  );
}

function showProviderHeading(items: AcpTranscriptItem[], index: number) {
  const item = items[index];
  if (!item || item.kind === "user" || item.kind === "turnEnd") return false;
  const previous = items[index - 1];
  return (
    previous === undefined ||
    previous.kind === "user" ||
    previous.kind === "turnEnd"
  );
}

function loginCommand(provider: AgentProvider) {
  return provider === "claude" ? "claude auth login" : "codex login";
}

function openAgentMessageLink(href: string) {
  void openUrl(href).catch(() => undefined);
}

function isLiveSession(lifecycle: AcpSessionLifecycle) {
  return (
    lifecycle === "starting" ||
    lifecycle === "ready" ||
    lifecycle === "running" ||
    lifecycle === "waitingPermission"
  );
}

const TranscriptItemView = memo(function TranscriptItemView({
  item,
  debugDetails,
  streaming,
  pendingPermissionId,
  permissionSubmitting,
  onPermission,
}: {
  item: AcpTranscriptItem;
  revision: number;
  debugDetails: boolean;
  streaming: boolean;
  pendingPermissionId: string | null;
  permissionSubmitting: string | null;
  onPermission: (requestId: string, optionId: string | null) => void;
}) {
  const { t } = useI18n();
  if (item.kind === "user") {
    return (
      <article className="tw:ml-6 tw:grid tw:max-w-full tw:min-w-0 tw:gap-1 tw:overflow-hidden tw:justify-items-end">
        <div className="tw:max-w-[92%] tw:min-w-0 tw:overflow-hidden tw:break-words tw:rounded-md tw:bg-selection tw:px-3 tw:py-2 tw:text-sm tw:leading-body tw:whitespace-pre-wrap tw:text-selection-foreground">
          {item.text}
        </div>
        {item.attachments.length > 0 ? (
          <small className="tw:max-w-full tw:break-all tw:text-right tw:text-muted-foreground">
            {item.attachments.join(" · ")}
          </small>
        ) : null}
      </article>
    );
  }
  if (item.kind === "agent") {
    return (
      <article className="tw:max-w-full tw:min-w-0 tw:overflow-hidden">
        {streaming ? (
          <AgentStreamingText
            chunks={item.chunks}
            revision={item.revision}
          />
        ) : (
          <AgentRichText
            labels={{
              copied: t("agent.acpCopied"),
              copyCode: t("agent.acpCopyCode"),
              diagram: t("agent.acpDiagram"),
              diagramError: t("agent.acpDiagramError"),
              diagramLoading: t("agent.acpDiagramLoading"),
              diagramSource: t("agent.acpDiagramSource"),
              imageOmitted: t("agent.acpImageOmitted"),
              openLink: t("agent.acpOpenLink"),
            }}
            onOpenLink={openAgentMessageLink}
            text={item.chunks.join("")}
          />
        )}
      </article>
    );
  }
  if (item.kind === "thought") {
    if (!debugDetails) {
      return (
        <AgentActivityLine
          label={progressActivityLabel(item.activityText, t)}
          tone="neutral"
        />
      );
    }
    return (
      <details className="tw:max-w-full tw:min-w-0 tw:overflow-hidden tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:px-2 tw:py-1 tw:text-xs">
        <summary className="tw:cursor-pointer tw:text-muted-foreground">
          {t("agent.acpThought")}
        </summary>
        <div className="tw:max-h-48 tw:max-w-full tw:overflow-auto tw:break-words tw:pt-2 tw:leading-body tw:whitespace-pre-wrap tw:text-muted-foreground">
          {item.chunks.join("")}
        </div>
      </details>
    );
  }
  if (item.kind === "tool") {
    return <ToolCallCard data={item.data} debugDetails={debugDetails} />;
  }
  if (item.kind === "permission") {
    const pending = item.event.requestId === pendingPermissionId;
    return (
      <AgentPermissionCard
        title={
          recordString(item.event.toolCall, "title") ??
          t("agent.acpPermission")
        }
        description={
          recordString(item.event.toolCall, "description") ??
          t("agent.acpPermission")
        }
        pending={pending}
        status={
          pending
            ? t("agent.acpPermissionWaiting")
            : t("agent.acpPermissionResolved")
        }
        actions={
          pending ? (
          <div className="tw:flex tw:flex-wrap tw:gap-2">
            {item.event.options.map((option) => (
              <PermissionButton
                key={option.id}
                option={option}
                disabled={permissionSubmitting === item.event.requestId}
                onClick={() =>
                  onPermission(item.event.requestId, option.id)
                }
              />
            ))}
            {item.event.options.some((option) =>
              option.kind.startsWith("reject")
            ) ? null : (
              <Button
                size="compact"
                variant="ghost"
                disabled={permissionSubmitting === item.event.requestId}
                onClick={() => onPermission(item.event.requestId, null)}
              >
                {t("agent.acpCancel")}
              </Button>
            )}
          </div>
          ) : (
            <small className="tw:text-muted-foreground">
              {t("agent.acpPermissionResolved")}
            </small>
          )
        }
      />
    );
  }
  if (item.kind === "plan") {
    const entries = Array.isArray(item.data.entries)
      ? item.data.entries
      : Array.isArray(item.data.plan)
        ? item.data.plan
        : [];
    if (!debugDetails) {
      return (
        <AgentActivityLine
          label={t("agent.acpActivityPlanning")}
          tone="neutral"
        />
      );
    }
    return (
      <section className="tw:grid tw:max-w-full tw:min-w-0 tw:gap-2 tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
        <strong className="tw:flex tw:items-center tw:gap-2 tw:text-sm">
          <Icon name="list" />
          {t("agent.acpPlan")}
        </strong>
        {entries.length > 0 ? (
          <ol className="tw:m-0 tw:grid tw:min-w-0 tw:gap-1 tw:pl-5 tw:text-xs tw:leading-body tw:[&>li]:break-words">
            {entries.map((entry, index) => (
              <li key={index}>{planEntryLabel(entry)}</li>
            ))}
          </ol>
        ) : (
          <pre className="tw:m-0 tw:max-h-48 tw:max-w-full tw:overflow-auto tw:break-all tw:text-xs tw:whitespace-pre-wrap">
            {safeJson(item.data)}
          </pre>
        )}
      </section>
    );
  }
  if (item.kind === "error") {
    return (
      <div
        className="tw:max-w-full tw:min-w-0 tw:overflow-hidden tw:break-words tw:rounded-md tw:border tw:border-danger-border tw:bg-danger-muted tw:px-3 tw:py-2 tw:text-sm tw:leading-body tw:text-danger"
        role="alert"
      >
        {item.message}
      </div>
    );
  }
  if (item.kind === "turnEnd") {
    return (
      <div className="tw:flex tw:items-center tw:gap-2 tw:text-xs tw:text-muted-foreground">
        <span className="tw:h-px tw:flex-1 tw:bg-border-subtle" />
        {stopReasonLabel(item.stopReason, t)}
        <span className="tw:h-px tw:flex-1 tw:bg-border-subtle" />
      </div>
    );
  }
  return null;
});

function ToolCallCard({
  data,
  debugDetails,
}: {
  data: Record<string, unknown>;
  debugDetails: boolean;
}) {
  const { t } = useI18n();
  const status = recordString(data, "status") ?? "pending";
  const title =
    recordString(data, "title") ??
    recordString(data, "kind") ??
    t("agent.acpToolRequest");
  const content = toolContentText(data.content);
  const rawOutput = data.rawOutput;
  const rawInput = data.rawInput;
  if (!debugDetails) {
    return (
      <AgentActivityLine
        label={toolActivityLabel(data, t)}
        status={toolStatusLabel(status, t)}
        tone={toolStatusTone(status)}
      />
    );
  }
  return (
    <AgentToolCallCard
      title={title}
      status={toolStatusLabel(status, t)}
      tone={toolStatusTone(status)}
      details={
        rawInput !== undefined || rawOutput !== undefined ? (
          <details className="tw:max-w-full tw:min-w-0 tw:overflow-hidden tw:text-xs">
            <summary className="tw:cursor-pointer tw:text-muted-foreground">
              {t("agent.acpToolDetails")}
            </summary>
            <pre className="tw:mt-2 tw:mb-0 tw:max-h-48 tw:max-w-full tw:overflow-auto tw:break-all tw:rounded-sm tw:bg-muted tw:p-2 tw:font-mono tw:text-2xs tw:leading-body tw:whitespace-pre-wrap">
              {safeJson({ input: rawInput, output: rawOutput })}
            </pre>
          </details>
        ) : null
      }
    >
      <div className="tw:grid tw:max-w-full tw:min-w-0 tw:gap-2 tw:overflow-hidden">
        {content ? (
          <details className="tw:max-w-full tw:min-w-0 tw:overflow-hidden tw:text-xs">
            <summary className="tw:cursor-pointer tw:text-muted-foreground">
              {t("agent.acpToolOutput")}
            </summary>
            <pre className="tw:mt-2 tw:mb-0 tw:max-h-48 tw:max-w-full tw:overflow-auto tw:break-all tw:rounded-sm tw:bg-muted tw:p-2 tw:font-mono tw:text-2xs tw:leading-body tw:whitespace-pre-wrap">
              {content}
            </pre>
          </details>
        ) : null}
        <AcpStructuredResult value={rawOutput ?? data.content} />
      </div>
    </AgentToolCallCard>
  );
}

function PermissionButton({
  option,
  disabled,
  onClick,
}: {
  option: AcpPermissionOption;
  disabled: boolean;
  onClick: () => void;
}) {
  const reject = option.kind.startsWith("reject");
  return (
    <Button
      size="compact"
      variant={reject ? "dangerGhost" : "primary"}
      disabled={disabled}
      onClick={onClick}
    >
      {option.name}
    </Button>
  );
}

function flattenConfigSelectOptions(option: AcpSessionConfigOption) {
  if (!Array.isArray(option.options)) return [];
  return option.options.flatMap((entry) =>
    "options" in entry ? entry.options : [entry],
  );
}

function providerLabel(provider: AgentProvider) {
  return provider === "claude" ? "Claude Agent" : "Codex";
}

function promptContext(
  connection: ConnectionProfile,
  activeDocument: WorkbenchDocument | null,
  selectedTable: CatalogTable | null,
  selection: ReturnType<typeof useAgentSelection>["selection"],
): AcpPromptContext {
  const document =
    activeDocument?.kind === "sql"
      ? {
          database: activeDocument.selectedDatabase || connection.database,
          documentName: activeDocument.title,
          documentText: readWorkbenchDraft(
            activeDocument.id,
            activeDocument.draft,
          ).slice(
            0,
            MAX_DOCUMENT_CONTEXT_CHARS,
          ),
        }
      : {
          database: null,
          documentName: null,
          documentText: null,
        };
  const activeDataTable =
    activeDocument?.kind === "data" ? activeDocument.table : selectedTable;
  if (!activeDataTable) {
    return {
      ...document,
      database: document.database ?? connection.database,
      table: null,
    };
  }
  const database = activeDataTable.database ?? connection.database;
  const selectedMatches =
    selection?.connectionId === connection.id &&
    (selection.database ?? connection.database) === database &&
    selection.table === activeDataTable.name &&
    (selection.schema ?? null) === (activeDataTable.schema ?? null);
  return {
    ...document,
    database,
    table: selectedMatches
      ? {
          database: selection.database,
          schema: selection.schema,
          table: selection.table,
          column: selection.column,
          rowIndex: selection.rowIndex,
          row: selection.row,
        }
      : {
          database,
          schema: activeDataTable.schema ?? null,
          table: activeDataTable.name,
          column: null,
          rowIndex: null,
          row: null,
        },
  };
}

function contextSummary(context: AcpPromptContext) {
  const labels: Array<{
    icon: "database" | "file" | "table" | "columns";
    text: string;
  }> = [];
  if (context.database !== null) {
    labels.push({
      icon: "database",
      text: context.database,
    });
  }
  if (context.documentText !== null) {
    labels.push({
      icon: "file",
      text: context.documentName ?? "SQL document",
    });
  }
  if (context.table) {
    labels.push({
      icon: "table",
      text: [
        context.table.database,
        context.table.schema,
        context.table.table,
      ].filter(Boolean).join("."),
    });
    if (context.table.column) {
      labels.push({
        icon: "columns",
        text: context.table.row
          ? `${context.table.column} · row ${
              (context.table.rowIndex ?? 0) + 1
            }`
          : context.table.column,
      });
    }
  }
  return labels;
}

function recordString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function contentText(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as Record<string, unknown>;
  return block.type === "text" && typeof block.text === "string"
    ? block.text
    : null;
}

function uiProjectionBoundary(event: AcpSessionEvent | null) {
  if (!event) return false;
  if (event.type !== "sessionUpdate") return true;
  return ![
    "agent_message_chunk",
    "agent_thought_chunk",
  ].includes(recordString(event.update, "sessionUpdate") ?? "");
}

function toolContentText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const text = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.text === "string") return [record.text];
    if (record.content) {
      const nested = contentText(record.content);
      return nested ? [nested] : [];
    }
    return [];
  });
  return text.length > 0 ? text.join("\n") : null;
}

function progressActivityLabel(
  text: string,
  t: ReturnType<typeof useI18n>["t"],
) {
  const normalized = text.toLocaleLowerCase();
  if (/(dashboard|chart|visuali[sz]|대시보드|차트|시각화)/.test(normalized)) {
    return t("agent.acpActivityDashboard");
  }
  if (/(connection|connect|database status|연결 상태|연결 확인)/.test(normalized)) {
    return t("agent.acpActivityConnection");
  }
  if (
    /(write|insert|update|delete|alter|create|drop|permission|approval|쓰기|추가|수정|삭제|변경|승인)/.test(
      normalized,
    )
  ) {
    return t("agent.acpActivityPrepareChange");
  }
  if (
    /(schema|column|catalog|describe|introspect|relation|스키마|컬럼|구조)/.test(
      normalized,
    )
  ) {
    return t("agent.acpActivityInspectSchema");
  }
  if (
    /(query|select|count|aggregate|row|result|sql|table|조회|쿼리|집계|결과|행|테이블)/.test(
      normalized,
    )
  ) {
    return t("agent.acpActivityQuery");
  }
  return t("agent.acpActivityReasoning");
}

function toolActivityLabel(
  data: Record<string, unknown>,
  t: ReturnType<typeof useI18n>["t"],
) {
  const identifier = [
    recordString(data, "title"),
    recordString(data, "kind"),
    recordString(data, "name"),
    recordString(data, "toolName"),
    recordString(data, "tool_name"),
  ]
    .filter((value): value is string => value !== null)
    .join(" ")
    .toLocaleLowerCase();

  if (/tool.?search/.test(identifier)) {
    return t("agent.acpActivityToolSearch");
  }
  if (/dashboard|chart|visuali[sz]/.test(identifier)) {
    return t("agent.acpActivityDashboard");
  }
  if (
    /table_describe|catalog|schema|describe|introspect|column|relation/.test(
      identifier,
    )
  ) {
    return t("agent.acpActivityInspectSchema");
  }
  if (
    /query_read|query|select|count|aggregate|execute|explain/.test(identifier)
  ) {
    return t("agent.acpActivityQuery");
  }
  if (/connection|database_list|status/.test(identifier)) {
    return t("agent.acpActivityConnection");
  }
  if (
    /propose|write|insert|update|delete|alter|create|drop/.test(identifier)
  ) {
    return t("agent.acpActivityPrepareChange");
  }
  return t("agent.acpActivityGeneric");
}

function toolStatusLabel(
  status: string,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (status === "completed") return t("agent.acpToolStatusCompleted");
  if (status === "failed" || status === "error") {
    return t("agent.acpToolStatusFailed");
  }
  if (status === "in_progress" || status === "running") {
    return t("agent.acpToolStatusRunning");
  }
  if (status === "cancelled") return t("agent.acpTurnCancelled");
  return t("agent.acpToolStatusPending");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function planEntryLabel(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return String(entry);
  }
  const record = entry as Record<string, unknown>;
  return (
    (typeof record.content === "string" && record.content) ||
    (typeof record.title === "string" && record.title) ||
    safeJson(record)
  );
}

function lifecycleTone(lifecycle: AcpSessionLifecycle): StatusTone {
  if (lifecycle === "ready") return "success";
  if (lifecycle === "running" || lifecycle === "waitingPermission") {
    return "warning";
  }
  if (lifecycle === "failed") return "danger";
  return "neutral";
}

function toolStatusTone(status: string): StatusTone {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "in_progress") return "warning";
  return "neutral";
}

function lifecycleLabel(
  lifecycle: AcpSessionLifecycle,
  t: ReturnType<typeof useI18n>["t"],
) {
  return t(`agent.acpLifecycle.${lifecycle}` as Parameters<typeof t>[0]);
}

function stopReasonLabel(
  reason: string,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (reason === "cancelled") return t("agent.acpTurnCancelled");
  if (reason === "refusal") return t("agent.acpTurnRefused");
  if (reason === "max_tokens" || reason === "max_turn_requests") {
    return t("agent.acpTurnLimited");
  }
  return t("agent.acpTurnComplete");
}
