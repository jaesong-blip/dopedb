import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { Icon } from "../../components/Icon";
import {
  AgentPermissionCard,
  AgentToolCallCard,
} from "../../design-system/components/Agent";
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
import { errMessage, type CatalogTable } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type { ConnectionProfile } from "../connections/domain";
import {
  clampTerminalDockWidth,
  TERMINAL_DOCK_DEFAULT_WIDTH,
} from "../terminals/layout";
import type { WorkbenchDocument } from "../workbench/domain";
import type {
  AcpPermissionOption,
  AcpPromptContext,
  AcpSessionConfigOption,
  AcpSessionEvent,
  AcpSessionId,
  AcpSessionLifecycle,
  AcpSessionSummary,
  AgentProvider,
} from "./domain";
import AcpStructuredResult from "./AcpStructuredResult";
import { useAgentSelection } from "./selectionContext";
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

// Four-byte Unicode remains within the Rust byte limits.
const MAX_DOCUMENT_CONTEXT_CHARS = 16 * 1024;
const MAX_PROMPT_CHARS = 8 * 1024;

type TranscriptItem =
  | {
      kind: "user";
      key: string;
      text: string;
      attachments: string[];
    }
  | {
      kind: "agent" | "thought";
      key: string;
      messageId: string | null;
      text: string;
    }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      data: Record<string, unknown>;
    }
  | {
      kind: "permission";
      key: string;
      event: Extract<AcpSessionEvent, { type: "permissionRequest" }>;
    }
  | {
      kind: "plan";
      key: string;
      data: Record<string, unknown>;
    }
  | {
      kind: "error";
      key: string;
      message: string;
    }
  | {
      kind: "turnEnd";
      key: string;
      stopReason: string;
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
  const [sessions, setSessions] = useState<AcpSessionSummary[]>([]);
  const [activeId, setActiveId] = useState<AcpSessionId | null>(null);
  const [eventsBySession, setEventsBySession] = useState<
    Record<string, AcpSessionEvent[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<AgentProvider>("codex");
  const [includeEditorContext, setIncludeEditorContext] = useState(true);
  const [configChanging, setConfigChanging] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [permissionSubmitting, setPermissionSubmitting] = useState<string | null>(
    null,
  );
  const transcriptRef = useRef<HTMLDivElement>(null);

  const connectionSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.connectionId === connection.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [connection.id, sessions],
  );
  const active =
    connectionSessions.find((session) => session.id === activeId) ?? null;
  const activeEventsLoaded =
    active !== null &&
    Object.prototype.hasOwnProperty.call(eventsBySession, active.id);
  const events = active ? eventsBySession[active.id] ?? [] : [];
  const transcript = useMemo(() => projectTranscript(events), [events]);
  const configOptions = useMemo(
    () => latestConfigOptions(events),
    [events],
  );
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
  const submittedContext = includeEditorContext
    ? context
    : {
        database: context.database,
        documentName: null,
        documentText: null,
        table: null,
      };
  const pendingPermissionId =
    active?.lifecycle === "waitingPermission"
      ? [...events]
          .reverse()
          .find((event) => event.type === "permissionRequest")
          ?.requestId ?? null
      : null;
  const dockLayout = compact ? "compact" : overlay ? "overlay" : "docked";

  const upsertSession = useCallback((session: AcpSessionSummary) => {
    setSessions((current) => {
      const exists = current.some((candidate) => candidate.id === session.id);
      return exists
        ? current.map((candidate) =>
            candidate.id === session.id ? session : candidate
          )
        : [...current, session];
    });
  }, []);

  const applyFocus = useCallback(
    (focus: {
      session: AcpSessionSummary;
      events: AcpSessionEvent[];
    }) => {
      upsertSession(focus.session);
      setEventsBySession((current) => ({
        ...current,
        [focus.session.id]: dedupeEvents(focus.events),
      }));
      setActiveId(focus.session.id);
    },
    [upsertSession],
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
        upsertSession(change.session);
        if (change.event) {
          setEventsBySession((current) => ({
            ...current,
            [change.session.id]: appendEvent(
              current[change.session.id] ?? [],
              change.event!,
            ),
          }));
        }
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
        setSessions(loaded);
        const next = loaded
          .filter((session) => session.connectionId === connection.id)
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
      unlisten?.();
    };
  }, [connection.id, t, upsertSession]);

  useEffect(() => {
    const next = connectionSessions[0]?.id ?? null;
    if (!activeId || !connectionSessions.some((session) => session.id === activeId)) {
      setActiveId(next);
    }
  }, [activeId, connectionSessions]);

  useEffect(() => {
    if (active) setSelectedProvider(active.provider);
  }, [active]);

  useEffect(() => {
    if (!active || eventsBySession[active.id]) return;
    void focusAgentAcpSession(active.id)
      .then(applyFocus)
      .catch((reason) =>
        setError(t("agent.acpLoadFailed", { error: errMessage(reason) }))
      );
  }, [active, applyFocus, eventsBySession, t]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [events.length, active?.id]);

  async function startSession(provider = selectedProvider) {
    if (starting) return null;
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
    } finally {
      setStarting(false);
    }
  }

  async function sendPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (starting || !prompt.trim()) return;
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
      await promptAgentAcpSession(session.id, submitted, submittedContext);
      setPrompt("");
    } catch (reason) {
      setError(t("agent.acpSendFailed", { error: errMessage(reason) }));
    }
  }

  async function changeProvider(provider: AgentProvider) {
    if (provider === selectedProvider && active?.provider === provider) return;
    setSelectedProvider(provider);
    if (active && active.provider !== provider) {
      await startSession(provider);
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

  async function respondPermission(
    requestId: string,
    optionId: string | null,
  ) {
    if (!active || permissionSubmitting) return;
    setPermissionSubmitting(requestId);
    setError(null);
    try {
      await respondAgentAcpPermission(active.id, requestId, optionId);
    } catch (reason) {
      setError(t("agent.acpPermissionFailed", { error: errMessage(reason) }));
    } finally {
      setPermissionSubmitting(null);
    }
  }

  async function cancelTurn() {
    if (!active) return;
    setError(null);
    try {
      await cancelAgentAcpSession(active.id);
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
    const move = (next: MouseEvent) => {
      onWidthChange(
        clampTerminalDockWidth(
          startWidth + startX - next.clientX,
          window.innerWidth,
        ),
      );
    };
    const up = () => {
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
        onDoubleClick={() => onWidthChange(TERMINAL_DOCK_DEFAULT_WIDTH)}
      />
      <ToolWindowHeader
        title={t("agent.acpTitle")}
        actions={
          <>
            <Button
              size="compact"
              variant="ghost"
              disabled={starting}
              onClick={() => void startSession()}
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
            <ToolWindowHideButton
              label={t("common.close")}
              onClick={onClose}
            />
          </>
        }
      />

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
          <div className="tw:mt-1 tw:flex tw:items-center tw:justify-between tw:border-t tw:border-border-subtle tw:px-1 tw:pt-1">
            <Button
              size="compact"
              variant="ghost"
              onClick={onOpenArchive}
            >
              <Icon name="history" />
              {t("agent.acpArchive")}
            </Button>
            {active &&
            active.lifecycle !== "closed" &&
            active.lifecycle !== "failed" ? (
              <Button
                iconOnly
                size="xs"
                variant="ghost"
                onClick={() => void closeSession()}
                title={t("agent.acpCloseSession")}
                aria-label={t("agent.acpCloseSession")}
              >
                <Icon name="trash" />
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      <div
        ref={transcriptRef}
        className="tw:min-h-0 tw:flex-1 tw:overflow-auto tw:overscroll-contain tw:bg-background tw:px-3 tw:py-4"
        aria-live="polite"
      >
        {loading || (active && !activeEventsLoaded) ? (
          <AgentEmpty>
            <LoadingLabel>{t("common.loading")}</LoadingLabel>
          </AgentEmpty>
        ) : starting && !active ? (
          <AgentEmpty>
            <LoadingLabel>{t("agent.acpStarting")}</LoadingLabel>
          </AgentEmpty>
        ) : !active ? (
          <AgentEmpty>
            <strong>{t("agent.acpEmptyTitle")}</strong>
            <p>{t("agent.acpEmptyBody")}</p>
            <ul className="tw:m-0 tw:grid tw:gap-2 tw:p-0 tw:text-left tw:list-none">
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
          <div className="tw:grid tw:gap-3">
            {transcript.map((item) => (
              <TranscriptItemView
                key={item.key}
                item={item}
                pendingPermissionId={pendingPermissionId}
                permissionSubmitting={permissionSubmitting}
                onPermission={(requestId, optionId) =>
                  void respondPermission(requestId, optionId)
                }
              />
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
          <div className="tw:flex tw:min-h-control-lg tw:items-center tw:gap-3 tw:border-x tw:border-t tw:border-border-subtle tw:bg-card tw:px-3 tw:py-2">
            <p className="tw:m-0 tw:min-w-0 tw:flex-1 tw:text-xs tw:leading-body tw:text-muted-foreground">
              {active.acpSessionId === null
                ? t("agent.acpRestartBody")
                : t("agent.acpResumeBody")}
            </p>
            <Button
              size="compact"
              variant="primary"
              disabled={starting}
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
        {includeEditorContext && contextLabels.length > 0 ? (
          <div className="tw:flex tw:flex-wrap tw:gap-1 tw:border-x tw:border-t tw:border-border-subtle tw:bg-card tw:px-2 tw:py-1">
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
        <ToolWindowComposer
          aria-label={t("agent.acpComposer")}
          onSubmit={sendPrompt}
        >
          <ToolWindowComposerInput
            value={prompt}
            maxLength={MAX_PROMPT_CHARS}
            disabled={
              starting ||
              (active !== null &&
                active.lifecycle !== "ready" &&
                active.lifecycle !== "closed" &&
                active.lifecycle !== "failed")
            }
            placeholder={t("agent.acpPrompt")}
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
          <div className="tw:flex tw:min-h-control-lg tw:items-center tw:gap-1 tw:px-2">
            {contextLabels.length > 0 ? (
              <Button
                type="button"
                iconOnly
                size="compact"
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
          <Icon name="user" className="tw:text-muted-foreground" />
          <select
            className="tw:h-control-sm tw:max-w-[9rem] tw:cursor-pointer tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-1 tw:font-sans tw:text-xs tw:text-foreground tw:outline-none tw:hover:bg-muted tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
            value={selectedProvider}
            disabled={starting}
            onChange={(event) =>
              void changeProvider(event.target.value as AgentProvider)
            }
            aria-label={t("agent.acpProvider")}
            title={t("agent.acpLocalAuth")}
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          {modelOption ? (
            <ConfigSelect
              option={modelOption}
              changing={configChanging === modelOption.id}
              onChange={(value) => void changeConfigOption(modelOption, value)}
            />
          ) : (
            <span className="tw:text-xs tw:text-muted-foreground">
              {t("agent.acpDefaultModel")}
            </span>
          )}
          <span className="tw:flex-1" />
          <span
            className="tw:max-w-[40%] tw:truncate tw:text-xs tw:text-muted-foreground"
            title={t("agent.acpPinned", {
              name: connection.name || t("app.unnamed"),
            })}
          >
            {connection.name || t("app.unnamed")}
          </span>
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

function TranscriptItemView({
  item,
  pendingPermissionId,
  permissionSubmitting,
  onPermission,
}: {
  item: TranscriptItem;
  pendingPermissionId: string | null;
  permissionSubmitting: string | null;
  onPermission: (requestId: string, optionId: string | null) => void;
}) {
  const { t } = useI18n();
  if (item.kind === "user") {
    return (
      <article className="tw:ml-6 tw:grid tw:gap-1 tw:justify-items-end">
        <div className="tw:max-w-[92%] tw:rounded-md tw:bg-selection tw:px-3 tw:py-2 tw:text-sm tw:leading-body tw:whitespace-pre-wrap tw:text-selection-foreground">
          {item.text}
        </div>
        {item.attachments.length > 0 ? (
          <small className="tw:text-right tw:text-muted-foreground">
            {item.attachments.join(" · ")}
          </small>
        ) : null}
      </article>
    );
  }
  if (item.kind === "agent") {
    return (
      <article className="tw:grid tw:grid-cols-[20px_minmax(0,1fr)] tw:gap-2">
        <span className="tw:grid tw:size-5 tw:place-items-center tw:rounded-full tw:bg-primary tw:text-primary-foreground">
          <Icon name="user" className="tw:size-3" />
        </span>
        <div className="tw:min-w-0 tw:text-sm tw:leading-body tw:whitespace-pre-wrap tw:text-foreground">
          {item.text}
        </div>
      </article>
    );
  }
  if (item.kind === "thought") {
    return (
      <details className="tw:ml-7 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:px-2 tw:py-1 tw:text-xs">
        <summary className="tw:cursor-pointer tw:text-muted-foreground">
          {t("agent.acpThought")}
        </summary>
        <div className="tw:pt-2 tw:leading-body tw:whitespace-pre-wrap tw:text-muted-foreground">
          {item.text}
        </div>
      </details>
    );
  }
  if (item.kind === "tool") {
    return <ToolCallCard data={item.data} />;
  }
  if (item.kind === "permission") {
    const pending = item.event.requestId === pendingPermissionId;
    return (
      <AgentPermissionCard
        title={t("agent.acpPermission")}
        description={
          recordString(item.event.toolCall, "title") ??
          t("agent.acpToolRequest")
        }
        pending={pending}
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
            <Button
              size="compact"
              variant="ghost"
              disabled={permissionSubmitting === item.event.requestId}
              onClick={() => onPermission(item.event.requestId, null)}
            >
              {t("agent.acpCancel")}
            </Button>
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
    return (
      <section className="tw:grid tw:gap-2 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
        <strong className="tw:flex tw:items-center tw:gap-2 tw:text-sm">
          <Icon name="list" />
          {t("agent.acpPlan")}
        </strong>
        {entries.length > 0 ? (
          <ol className="tw:m-0 tw:grid tw:gap-1 tw:pl-5 tw:text-xs tw:leading-body">
            {entries.map((entry, index) => (
              <li key={index}>{planEntryLabel(entry)}</li>
            ))}
          </ol>
        ) : (
          <pre className="tw:m-0 tw:overflow-auto tw:text-xs tw:whitespace-pre-wrap">
            {safeJson(item.data)}
          </pre>
        )}
      </section>
    );
  }
  if (item.kind === "error") {
    return (
      <div
        className="tw:rounded-md tw:border tw:border-danger-border tw:bg-danger-muted tw:px-3 tw:py-2 tw:text-sm tw:leading-body tw:text-danger"
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
}

function ToolCallCard({ data }: { data: Record<string, unknown> }) {
  const { t } = useI18n();
  const status = recordString(data, "status") ?? "pending";
  const title =
    recordString(data, "title") ??
    recordString(data, "kind") ??
    t("agent.acpToolRequest");
  const content = toolContentText(data.content);
  const rawOutput = data.rawOutput;
  const rawInput = data.rawInput;
  return (
    <AgentToolCallCard
      title={title}
      status={status.replace(/_/g, " ")}
      tone={toolStatusTone(status)}
      details={
        rawInput !== undefined || rawOutput !== undefined ? (
          <details className="tw:text-xs">
            <summary className="tw:cursor-pointer tw:text-muted-foreground">
              {t("agent.acpToolDetails")}
            </summary>
            <pre className="tw:mt-2 tw:mb-0 tw:max-h-48 tw:overflow-auto tw:rounded-sm tw:bg-muted tw:p-2 tw:font-mono tw:text-2xs tw:leading-body tw:whitespace-pre-wrap">
              {safeJson({ input: rawInput, output: rawOutput })}
            </pre>
          </details>
        ) : null
      }
    >
      {content ? (
        <div className="tw:text-xs tw:leading-body tw:whitespace-pre-wrap">
          {content}
        </div>
      ) : null}
      <AcpStructuredResult value={rawOutput ?? data.content} />
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

function projectTranscript(events: AcpSessionEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolIndex = new Map<string, number>();
  for (const event of events) {
    const key = `${event.sessionId}:${event.sequence}`;
    if (event.type === "userMessage") {
      items.push({
        kind: "user",
        key,
        text: event.text,
        attachments: event.attachments,
      });
      continue;
    }
    if (event.type === "permissionRequest") {
      items.push({ kind: "permission", key, event });
      continue;
    }
    if (event.type === "error") {
      items.push({ kind: "error", key, message: event.message });
      continue;
    }
    if (event.type === "turnEnd") {
      items.push({ kind: "turnEnd", key, stopReason: event.stopReason });
      continue;
    }
    if (event.type !== "sessionUpdate") continue;
    const update = event.update;
    const kind = recordString(update, "sessionUpdate");
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const text = contentText(update.content);
      if (!text) continue;
      const itemKind = kind === "agent_message_chunk" ? "agent" : "thought";
      const messageId = recordString(update, "messageId");
      const previous = items[items.length - 1];
      if (
        previous &&
        previous.kind === itemKind &&
        (messageId === null || previous.messageId === messageId)
      ) {
        previous.text += text;
      } else {
        items.push({ kind: itemKind, key, messageId, text });
      }
      continue;
    }
    if (kind === "tool_call") {
      const toolCallId = recordString(update, "toolCallId") ?? key;
      toolIndex.set(toolCallId, items.length);
      items.push({ kind: "tool", key, toolCallId, data: update });
      continue;
    }
    if (kind === "tool_call_update") {
      const toolCallId = recordString(update, "toolCallId") ?? key;
      const index = toolIndex.get(toolCallId);
      if (index !== undefined && items[index]?.kind === "tool") {
        const previous = items[index] as Extract<TranscriptItem, { kind: "tool" }>;
        items[index] = {
          ...previous,
          data: { ...previous.data, ...update },
        };
      } else {
        toolIndex.set(toolCallId, items.length);
        items.push({ kind: "tool", key, toolCallId, data: update });
      }
      continue;
    }
    if (kind === "plan") {
      items.push({ kind: "plan", key, data: update });
    }
  }
  return items;
}

function latestConfigOptions(
  events: AcpSessionEvent[],
): AcpSessionConfigOption[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "sessionConfiguration") {
      return event.configOptions;
    }
  }
  return [];
}

function flattenConfigSelectOptions(option: AcpSessionConfigOption) {
  if (!Array.isArray(option.options)) return [];
  return option.options.flatMap((entry) =>
    "options" in entry ? entry.options : [entry],
  );
}

function providerLabel(provider: AgentProvider) {
  return provider === "claude" ? "Claude" : "Codex";
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
          documentText: activeDocument.draft.slice(
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
    icon: "file" | "table" | "columns";
    text: string;
  }> = [];
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

function dedupeEvents(events: AcpSessionEvent[]) {
  return [...new Map(events.map((event) => [event.sequence, event])).values()]
    .sort((a, b) => a.sequence - b.sequence);
}

function appendEvent(
  events: AcpSessionEvent[],
  event: AcpSessionEvent,
): AcpSessionEvent[] {
  if (events.some((candidate) => candidate.sequence === event.sequence)) {
    return events;
  }
  return [...events, event].sort((a, b) => a.sequence - b.sequence);
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
