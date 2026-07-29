// Persistent PTY dock controller: owns session tabs, bounded replay routing,
// focus containment, and connection-pinned lifecycle actions.
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type {
  SkillInstallState,
  SkillStatus,
} from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import type { WorkbenchDocument } from "../../features/workbench/domain";
import { workspaceContextQuery } from "../../features/workspaces/queries";
import {
  clampTerminalDockWidth,
  TERMINAL_DOCK_DEFAULT_WIDTH,
} from "../../features/terminals/layout";
import {
  runTerminalCloseBatch,
  shouldCloseTerminalFromShortcut,
  terminalCloseTargetIds,
  type TerminalCloseAction,
  type TerminalCloseResult,
} from "../../features/terminals/commands";
import {
  terminalClose,
  terminalCreate,
  terminalFocus,
  terminalKill,
  terminalList,
  terminalOutputChannel,
  terminalRename,
  terminalRestart,
  terminalWrite,
} from "../../features/terminals/tauriAdapter";
import {
  terminalSessionId,
  type TerminalOutputChunk,
  type TerminalProfile,
  type TerminalSessionId,
  type TerminalSessionSummary,
  type TerminalStateEvent,
} from "../../features/terminals/domain";
import {
  initialTerminalDockState,
  terminalActiveIdForScope,
  terminalDockReducer,
  terminalLayoutForScope,
  terminalSessionIsRunning,
  terminalScopeKey,
  terminalSessionsForScope,
  type TerminalScopeKey,
  type TerminalSessionScope,
  type TerminalDockState,
} from "../../features/terminals/state";
import {
  InlineNotice,
  LoadingLabel,
} from "../../design-system/components/Status";
import {
  ToolWindowComposer,
  ToolWindowComposerContext,
  ToolWindowComposerDock,
  ToolWindowComposerInput,
} from "../../design-system/components/ToolWindow";
import { Icon } from "../Icon";
import TerminalContextBar from "./TerminalContextBar";
import TerminalSurface from "./TerminalSurface";
import TerminalTabs, {
  TerminalEmptyActions,
  type TerminalPresentation,
  type TerminalPopup,
} from "./TerminalTabs";
import { useI18n } from "../../lib/i18n";

const OUTPUT_REPLAY_BYTES = 512 * 1024;
const ACTIVE_SESSION_STORAGE = "terminalActiveSessionByScope";
// A JavaScript character can encode to four UTF-8 bytes. Keep the composer
// below the Terminal backend's 64 KiB input boundary including paste markers.
const AGENT_PROMPT_MAX_CHARS = 12 * 1024;
const AGENT_DOCUMENT_CONTEXT_MAX_CHARS = 4 * 1024;

type AgentProfile = Exclude<TerminalProfile, "shell">;
type AgentAttachment = "database" | "document";

type OutputWriter = (chunk: TerminalOutputChunk) => void;

interface TerminalDockProps {
  connection: ConnectionProfile;
  documents: WorkbenchDocument[];
  activeDocumentId: string | null;
  skillStatus: SkillStatus | null;
  overlay: boolean;
  compact?: boolean;
  width: number;
  presentation?: TerminalPresentation;
  onWidthChange: (width: number) => void;
  onOpenArchive: () => void;
  onClose: () => void;
}

function TerminalEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="tw:m-auto tw:flex tw:w-[min(440px,calc(100%_-_var(--ds-space-6)))] tw:flex-col tw:items-center tw:gap-3 tw:self-center tw:text-center tw:text-muted-foreground tw:[&>.icon]:size-7 tw:[&>.icon]:text-foreground tw:[&>strong]:text-title tw:[&>strong]:text-foreground tw:[&>p]:m-0 tw:[&>p]:max-w-[420px] tw:[&>p]:leading-body">
      {children}
    </div>
  );
}

function buildAgentPrompt({
  prompt,
  attachments,
  connection,
  document,
}: {
  prompt: string;
  attachments: AgentAttachment[];
  connection: ConnectionProfile;
  document: WorkbenchDocument | null;
}) {
  const context: string[] = [];
  if (attachments.includes("database")) {
    context.push(
      [
        "Attached data source:",
        `- Name: ${connection.name || "(unnamed)"}`,
        `- Engine: ${connection.engine}`,
        `- Database: ${connection.database}`,
      ].join("\n"),
    );
  }
  if (
    attachments.includes("document") &&
    document &&
    (document.kind === "sql" || document.kind === "documents")
  ) {
    const draft = document.draft ?? "";
    const content = draft.slice(
      0,
      AGENT_DOCUMENT_CONTEXT_MAX_CHARS,
    );
    context.push(
      [
        `Attached SQL document: ${document.kind === "sql" ? document.title : "Document"}`,
        "```sql",
        content,
        draft.length > content.length
          ? "-- Context truncated by DopeDB"
          : "",
        "```",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (context.length === 0) return prompt;
  const prefixBudget = Math.max(
    0,
    AGENT_PROMPT_MAX_CHARS - prompt.length - 2,
  );
  const prefix = context.join("\n\n").slice(0, prefixBudget).trim();
  return prefix ? `${prefix}\n\n${prompt}` : prompt;
}

function restoreTerminalDockState(
  base: TerminalDockState,
): TerminalDockState {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(ACTIVE_SESSION_STORAGE) ?? "{}",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return base;
    }
    const saved = parsed as {
      activeIdByScope?: unknown;
      layoutByScope?: unknown;
    };
    if (
      !saved.activeIdByScope ||
      typeof saved.activeIdByScope !== "object" ||
      Array.isArray(saved.activeIdByScope)
    ) {
      return base;
    }
    const activeIdByScope: TerminalDockState["activeIdByScope"] = {};
    for (const [id, sessionId] of Object.entries(saved.activeIdByScope)) {
      if (typeof sessionId === "string") {
        activeIdByScope[id as TerminalScopeKey] = terminalSessionId(sessionId);
      }
    }
    const layoutByScope: TerminalDockState["layoutByScope"] = {};
    if (saved.layoutByScope && typeof saved.layoutByScope === "object") {
      for (const [id, layout] of Object.entries(saved.layoutByScope)) {
        if (
          layout &&
          typeof layout === "object" &&
          "maximized" in layout &&
          typeof layout.maximized === "boolean"
        ) {
          layoutByScope[id as TerminalScopeKey] = {
            maximized: layout.maximized,
          };
        }
      }
    }
    return { ...base, activeIdByScope, layoutByScope };
  } catch {
    return base;
  }
}

export default function TerminalDock({
  connection,
  documents,
  activeDocumentId,
  skillStatus,
  overlay,
  compact = false,
  width,
  presentation = "terminal",
  onWidthChange,
  onOpenArchive,
  onClose,
}: TerminalDockProps) {
  const { t } = useI18n();
  const workspaceContext = useQuery(workspaceContextQuery());
  const [state, dispatch] = useReducer(
    terminalDockReducer,
    initialTerminalDockState,
    restoreTerminalDockState,
  );
  const [popup, setPopup] = useState<TerminalPopup | null>(null);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentProfile, setAgentProfile] =
    useState<AgentProfile>("codex");
  const [agentAttachments, setAgentAttachments] = useState<
    AgentAttachment[]
  >([]);
  const [agentAttachmentMenuOpen, setAgentAttachmentMenuOpen] =
    useState(false);
  const [sendingAgentPrompt, setSendingAgentPrompt] = useState(false);
  const [closingId, setClosingId] = useState<TerminalSessionId | null>(null);
  const dockRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const currentScopeRef = useRef<TerminalSessionScope | null>(null);
  const popupScopeKeyRef = useRef<TerminalScopeKey | null>(null);
  const visibleSessionsRef = useRef<TerminalSessionSummary[]>([]);
  const closingIdRef = useRef<TerminalSessionId | null>(null);
  const channelsRef = useRef(
    new Map<TerminalSessionId, ReturnType<typeof terminalOutputChannel>>(),
  );
  const writersRef = useRef(new Map<TerminalSessionId, OutputWriter>());
  const replayRef = useRef(new Map<TerminalSessionId, TerminalOutputChunk[]>());
  const replayBytesRef = useRef(new Map<TerminalSessionId, number>());
  const lastSequenceRef = useRef(new Map<TerminalSessionId, number>());
  const retiredRef = useRef(new Set<TerminalSessionId>());
  const currentScope = useMemo<TerminalSessionScope | null>(
    () =>
      workspaceContext.data
        ? {
            workspaceId: workspaceContext.data.active.id,
            connectionId: connection.id,
          }
        : null,
    [connection.id, workspaceContext.data],
  );
  currentScopeRef.current = currentScope;
  const currentScopeKey = currentScope ? terminalScopeKey(currentScope) : null;
  const maximized = terminalLayoutForScope(state, currentScope).maximized;
  const dockLayout = maximized
    ? "maximized"
    : compact
      ? "compact"
      : overlay
        ? "overlay"
        : "docked";
  const activeDocument =
    documents.find((document) => document.id === activeDocumentId) ?? null;
  const attachableDocument =
    activeDocument?.kind === "sql" || activeDocument?.kind === "documents"
      ? activeDocument
      : null;

  useEffect(() => {
    setAgentPrompt("");
    setAgentAttachments([]);
    setAgentAttachmentMenuOpen(false);
  }, [connection.id]);

  useEffect(() => {
    setAgentAttachments((current) =>
      current.filter((attachment) => attachment !== "document"),
    );
  }, [activeDocumentId]);

  const focusDockTarget = useCallback(() => {
    window.requestAnimationFrame(() => {
      dockRef.current
        ?.querySelector<HTMLElement>(
          '[data-terminal-focus-target="active-session"], [data-terminal-focus-target="launcher"]',
        )
        ?.focus();
    });
  }, []);

  const dismissPopup = useCallback(() => {
    const trigger = popup?.trigger;
    setPopup(null);
    window.requestAnimationFrame(() => {
      if (
        trigger?.isConnected &&
        dockRef.current?.contains(trigger)
      ) {
        trigger.focus();
      } else {
        focusDockTarget();
      }
    });
  }, [focusDockTarget, popup]);

  useEffect(() => {
    localStorage.setItem(
      ACTIVE_SESSION_STORAGE,
      JSON.stringify({
        activeIdByScope: state.activeIdByScope,
        layoutByScope: state.layoutByScope,
      }),
    );
  }, [state.activeIdByScope, state.layoutByScope]);

  const routeOutput = useCallback((chunk: TerminalOutputChunk) => {
    const previous = lastSequenceRef.current.get(chunk.sessionId) ?? 0;
    if (chunk.sequence <= previous) return;
    lastSequenceRef.current.set(chunk.sessionId, chunk.sequence);

    const queued = replayRef.current.get(chunk.sessionId) ?? [];
    queued.push(chunk);
    let bytes =
      (replayBytesRef.current.get(chunk.sessionId) ?? 0) + chunk.bytes.length;
    while (bytes > OUTPUT_REPLAY_BYTES && queued.length > 0) {
      const dropped = queued.shift();
      bytes -= dropped?.bytes.length ?? 0;
      dispatch({ type: "replayTruncated", id: chunk.sessionId });
    }
    replayRef.current.set(chunk.sessionId, queued);
    replayBytesRef.current.set(chunk.sessionId, bytes);
    writersRef.current.get(chunk.sessionId)?.(chunk);
  }, []);

  const makeChannel = useCallback(
    () => terminalOutputChannel(routeOutput),
    [routeOutput],
  );

  const ensureChannel = useCallback(
    (id: TerminalSessionId) => {
      const existing = channelsRef.current.get(id);
      if (existing) return existing;
      const channel = makeChannel();
      channelsRef.current.set(id, channel);
      return channel;
    },
    [makeChannel],
  );

  const attachSession = useCallback(
    async (id: TerminalSessionId) => {
      const receipt = await terminalFocus(
        id,
        lastSequenceRef.current.get(id) ?? null,
        ensureChannel(id),
      );
      dispatch({ type: "upsert", session: receipt.session });
      if (receipt.replayTruncated) {
        dispatch({ type: "replayTruncated", id });
      }
    },
    [ensureChannel],
  );

  const loadSessions = useCallback(async () => {
    try {
      const sessions = await terminalList();
      dispatch({
        type: "loaded",
        sessions,
        currentScope: currentScopeRef.current,
      });
      const attached = await Promise.allSettled(
        sessions.map((session) => attachSession(session.id)),
      );
      const failed = attached.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failed) {
        dispatch({ type: "error", error: errMessage(failed.reason) });
      }
    } catch (error) {
      dispatch({ type: "loadFailed", error: errMessage(error) });
    }
  }, [attachSession]);

  useEffect(() => {
    let disposed = false;
    const stateListener = listen<TerminalStateEvent>(
      "terminal:state",
      (event) => {
        if (
          disposed ||
          retiredRef.current.has(event.payload.session.id)
        ) {
          return;
        }
        dispatch({ type: "upsert", session: event.payload.session });
      },
    ).catch((error) => {
      if (!disposed) {
        dispatch({ type: "error", error: errMessage(error) });
      }
      return null;
    });
    void loadSessions();

    return () => {
      disposed = true;
      void stateListener.then((unlisten) => unlisten?.());
      writersRef.current.clear();
      replayRef.current.clear();
      replayBytesRef.current.clear();
      channelsRef.current.clear();
      lastSequenceRef.current.clear();
    };
  }, [loadSessions]);

  const registerOutput = useCallback(
    (id: TerminalSessionId, writer: OutputWriter | null) => {
      if (!writer) {
        writersRef.current.delete(id);
        return;
      }
      writersRef.current.set(id, writer);
      for (const chunk of replayRef.current.get(id) ?? []) writer(chunk);
    },
    [],
  );

  useEffect(() => {
    const clamp = () => {
      const next = clampTerminalDockWidth(width, window.innerWidth);
      if (next !== width) onWidthChange(next);
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [onWidthChange, width]);

  useEffect(() => {
    const modal = overlay || maximized;
    if (!modal && !popup) return;
    const inertTargets = modal
      ? [
          document.querySelector<HTMLElement>(".main"),
          document.querySelector<HTMLElement>(".sidebar"),
          document.querySelector<HTMLElement>(".workbench-rail"),
        ].filter((target): target is HTMLElement => target !== null)
      : [];
    inertTargets.forEach((target) => target.setAttribute("inert", ""));
    const frame = window.requestAnimationFrame(() => {
      if (modal && !popup) {
        closeRef.current?.focus();
      }
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (popup) {
          dismissPopup();
        } else if (maximized) {
          if (currentScope) {
            dispatch({
              type: "setLayout",
              scope: currentScope,
              layout: { maximized: false },
            });
          }
        } else {
          onClose();
        }
        return;
      }
      if (!modal || event.key !== "Tab") return;
      const focusable = Array.from(
        dockRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dockRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      inertTargets.forEach((target) => target.removeAttribute("inert"));
    };
  }, [currentScope, dismissPopup, maximized, onClose, overlay, popup]);

  const visibleSessions = useMemo(
    () =>
      currentScope ? terminalSessionsForScope(state.sessions, currentScope) : [],
    [currentScope, state.sessions],
  );
  const activeId = terminalActiveIdForScope(state, currentScope);
  const active = useMemo(
    () =>
      visibleSessions.find((session) => session.id === activeId) ?? null,
    [activeId, visibleSessions],
  );
  useEffect(() => {
    if (active?.profile === "codex" || active?.profile === "claude") {
      setAgentProfile(active.profile);
    }
  }, [active?.id, active?.profile]);
  visibleSessionsRef.current = visibleSessions;
  useEffect(() => {
    if (!popup) return;
    const targetIsStale =
      popup.kind === "tab" &&
      !visibleSessions.some((session) => session.id === popup.targetId);
    if (popupScopeKeyRef.current !== currentScopeKey || targetIsStale) {
      dismissPopup();
    }
  }, [currentScopeKey, dismissPopup, popup, visibleSessions]);
  const activeSkillState = useMemo<SkillInstallState | null>(() => {
    if (!active || active.profile === "shell") return null;
    const target = active.profile === "codex" ? "codex" : "claude-code";
    return (
      skillStatus?.targets.find((candidate) => candidate.target === target)
        ?.state ?? (skillStatus ? "missing" : null)
    );
  }, [active, skillStatus]);

  const reportError = useCallback((message: string) => {
    dispatch({ type: "error", error: message });
  }, []);

  async function createSession(
    profile: TerminalProfile,
  ): Promise<TerminalSessionSummary | null> {
    setPopup(null);
    dispatch({ type: "error", error: null });
    dispatch({ type: "creating", profile });
    const channel = makeChannel();
    try {
      const session = await terminalCreate(
        {
          connectionId: connection.id,
          profile,
          size: active?.size ?? {
            cols: 100,
            rows: 30,
            pixelWidth: 0,
            pixelHeight: 0,
          },
        },
        channel,
      );
      channelsRef.current.set(session.id, channel);
      dispatch({ type: "upsert", session });
      dispatch({ type: "activate", id: session.id });
      return session;
    } catch (error) {
      dispatch({
        type: "error",
        error: t("terminal.createFailed", { error: errMessage(error) }),
      });
      return null;
    } finally {
      dispatch({ type: "creating", profile: null });
    }
  }

  async function submitAgentPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = agentPrompt.trim();
    if (!prompt || sendingAgentPrompt) return;
    setSendingAgentPrompt(true);
    dispatch({ type: "error", error: null });
    try {
      const session =
        active &&
          active.profile === agentProfile &&
          terminalSessionIsRunning(active)
          ? active
          : await createSession(agentProfile);
      if (!session) return;
      const normalized = buildAgentPrompt({
        prompt: prompt.replace(/\r\n?/g, "\n"),
        attachments: agentAttachments,
        connection,
        document: attachableDocument,
      });
      const input = normalized.includes("\n")
        ? `\u001b[200~${normalized}\u001b[201~\r`
        : `${normalized}\r`;
      await terminalWrite(session.id, [
        ...new TextEncoder().encode(input),
      ]);
      setAgentPrompt("");
      setAgentAttachments([]);
      setAgentAttachmentMenuOpen(false);
    } catch (error) {
      dispatch({
        type: "error",
        error: t("terminal.inputFailed", { error: errMessage(error) }),
      });
    } finally {
      setSendingAgentPrompt(false);
    }
  }

  function attachAgentContext(attachment: AgentAttachment) {
    setAgentAttachments((current) =>
      current.includes(attachment)
        ? current
        : [...current, attachment],
    );
    setAgentPrompt((current) =>
      current.endsWith("@") ? current.slice(0, -1) : current,
    );
    setAgentAttachmentMenuOpen(false);
  }

  function removeAgentContext(attachment: AgentAttachment) {
    setAgentAttachments((current) =>
      current.filter((candidate) => candidate !== attachment),
    );
  }

  async function stopSession(session: TerminalSessionSummary) {
    if (!window.confirm(t("terminal.stopConfirm"))) return;
    dispatch({ type: "error", error: null });
    try {
      const next = await terminalKill(session.id);
      dispatch({ type: "upsert", session: next });
    } catch (error) {
      dispatch({ type: "error", error: errMessage(error) });
    }
  }

  const retireSessionResources = useCallback((id: TerminalSessionId) => {
    retiredRef.current.add(id);
    channelsRef.current.delete(id);
    writersRef.current.delete(id);
    replayRef.current.delete(id);
    replayBytesRef.current.delete(id);
    lastSequenceRef.current.delete(id);
  }, []);

  const closeVisibleSession = useCallback(
    async (id: TerminalSessionId): Promise<TerminalCloseResult> => {
      const session = visibleSessionsRef.current.find((candidate) => candidate.id === id);
      if (!session || closingIdRef.current) return "stale";
      if (
        terminalSessionIsRunning(session) &&
        !window.confirm(t("terminal.closeConfirm"))
      ) {
        return "cancelled";
      }
      closingIdRef.current = id;
      setClosingId(session.id);
      dispatch({ type: "error", error: null });
      retireSessionResources(session.id);
      try {
        await terminalClose(session.id);
        dispatch({ type: "remove", id: session.id });
        focusDockTarget();
        return "closed";
      } catch (error) {
        retiredRef.current.delete(session.id);
        dispatch({
          type: "error",
          error: t("terminal.closeFailed", { error: errMessage(error) }),
        });
        await loadSessions();
        return "failed";
      } finally {
        closingIdRef.current = null;
        setClosingId(null);
      }
    },
    [focusDockTarget, loadSessions, retireSessionResources, t],
  );

  const closeAction = useCallback(
    async (targetId: TerminalSessionId, action: TerminalCloseAction) => {
      const ids = terminalCloseTargetIds(
        visibleSessionsRef.current,
        targetId,
        action,
      );
      await runTerminalCloseBatch(ids, closeVisibleSession);
    },
    [closeVisibleSession],
  );

  async function restartSession(session: TerminalSessionSummary) {
    dispatch({ type: "error", error: null });
    const channel = makeChannel();
    try {
      const next = await terminalRestart(session.id, channel);
      retireSessionResources(session.id);
      channelsRef.current.set(next.id, channel);
      dispatch({ type: "replace", previousId: session.id, session: next });
    } catch (error) {
      dispatch({ type: "error", error: errMessage(error) });
      await loadSessions();
    }
  }

  useEffect(() => {
    const handleCloseShortcut = (event: KeyboardEvent) => {
      if (!active || !shouldCloseTerminalFromShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        focusInsideDock:
          (event.target instanceof Node &&
            (dockRef.current?.contains(event.target) ?? false)) ||
          (popup !== null &&
            event.target instanceof Node &&
            (document
              .querySelector<HTMLElement>("[data-terminal-popup]")
              ?.contains(event.target) ?? false)),
      })) {
        return;
      }
      event.preventDefault();
      if (popup) dismissPopup();
      void closeAction(active.id, "one");
    };
    document.addEventListener("keydown", handleCloseShortcut);
    return () =>
      document.removeEventListener("keydown", handleCloseShortcut);
  }, [active, closeAction, dismissPopup, popup]);

  async function renameSession(session: TerminalSessionSummary) {
    const name = window.prompt(t("terminal.renamePrompt"), session.name);
    if (name === null || name.trim() === session.name) return;
    try {
      const next = await terminalRename(session.id, name);
      dispatch({ type: "upsert", session: next });
    } catch (error) {
      dispatch({ type: "error", error: errMessage(error) });
    }
  }

  function beginResize(event: React.MouseEvent<HTMLDivElement>) {
    if (maximized || overlay) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (next: MouseEvent) => {
      onWidthChange(
        clampTerminalDockWidth(startWidth + startX - next.clientX, window.innerWidth),
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
    <>
      <aside
        ref={dockRef}
        className="terminal-dock tw:relative tw:col-start-4 tw:row-start-2 tw:m-1 tw:ml-0 tw:flex tw:min-w-0 tw:flex-col tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:bg-background tw:data-[layout=overlay]:fixed tw:data-[layout=overlay]:inset-y-0 tw:data-[layout=overlay]:right-0 tw:data-[layout=overlay]:z-[var(--ds-z-modal)] tw:data-[layout=overlay]:m-0 tw:data-[layout=overlay]:w-[min(520px,calc(100vw_-_44px))] tw:data-[layout=overlay]:rounded-none tw:data-[layout=overlay]:shadow-popover tw:data-[layout=compact]:fixed tw:data-[layout=compact]:top-title-toolbar tw:data-[layout=compact]:right-0 tw:data-[layout=compact]:bottom-20 tw:data-[layout=compact]:left-0 tw:data-[layout=compact]:z-[var(--ds-z-modal)] tw:data-[layout=compact]:m-0 tw:data-[layout=compact]:w-screen tw:data-[layout=compact]:rounded-none tw:data-[layout=compact]:border-x-0 tw:data-[layout=maximized]:fixed tw:data-[layout=maximized]:inset-0 tw:data-[layout=maximized]:z-[var(--ds-z-modal)] tw:data-[layout=maximized]:m-0 tw:data-[layout=maximized]:h-dvh tw:data-[layout=maximized]:w-screen tw:data-[layout=maximized]:rounded-none tw:data-[layout=maximized]:border-0"
        data-layout={dockLayout}
        aria-label={t(
          presentation === "agent"
            ? "terminal.agentTitle"
            : "terminal.title",
        )}
        role={dockLayout === "docked" ? undefined : "dialog"}
        aria-modal={dockLayout === "docked" ? undefined : true}
      >
        <div
          className="terminal-dock-resizer tw:absolute tw:inset-y-0 tw:-left-[3px] tw:z-[var(--ds-z-raised)] tw:w-[7px] tw:cursor-col-resize tw:hover:bg-ring/30 tw:active:bg-ring/30 tw:data-[layout=overlay]:hidden tw:data-[layout=compact]:hidden tw:data-[layout=maximized]:hidden"
          data-layout={dockLayout}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("app.dragResize")}
          onMouseDown={beginResize}
          onDoubleClick={() => onWidthChange(TERMINAL_DOCK_DEFAULT_WIDTH)}
        />
        <TerminalTabs
          sessions={visibleSessions}
          activeId={activeId}
          creatingProfile={state.creatingProfile}
          closingId={closingId}
          maximized={maximized}
          popup={popup}
          presentation={presentation}
          closeButtonRef={closeRef}
          onActivate={(id) => dispatch({ type: "activate", id })}
          onCloseAction={(id, action) => void closeAction(id, action)}
          onOpenPopup={(next) => {
            popupScopeKeyRef.current = currentScopeKey;
            setPopup(next);
          }}
          onDismissPopup={dismissPopup}
          onCreate={(profile) => void createSession(profile)}
          onToggleMaximize={() => {
            if (!currentScope) return;
            dispatch({
              type: "setLayout",
              scope: currentScope,
              layout: { maximized: !maximized },
            });
          }}
          onOpenArchive={onOpenArchive}
          onPanelClose={onClose}
        />

        {state.error && (
          <InlineNotice
            tone="danger"
            icon="alert"
            role="alert"
            action={
              <button
                type="button"
                className="btn small icon-only icon-xs"
                onClick={() => dispatch({ type: "error", error: null })}
                title={t("common.close")}
                aria-label={t("common.close")}
              >
                <Icon name="close" />
              </button>
            }
          >
            {state.error}
          </InlineNotice>
        )}

        {active && (
          <TerminalContextBar
            active={active}
            skillState={activeSkillState}
            replayTruncated={state.replayTruncated.includes(active.id)}
            onRename={() => void renameSession(active)}
            onStop={() => void stopSession(active)}
            onRestart={() => void restartSession(active)}
          />
        )}

        <div className="tw:relative tw:flex tw:min-h-0 tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:bg-background">
          {state.loading ? (
            <TerminalEmpty>
              <LoadingLabel>{t("common.loading")}</LoadingLabel>
            </TerminalEmpty>
          ) : visibleSessions.length === 0 ? (
            <TerminalEmpty>
              {presentation === "agent" ? (
                <div className="tw:grid tw:gap-4 tw:text-left tw:text-sm">
                  <div className="tw:flex tw:items-center tw:gap-2">
                    <Icon name="database" />
                    <span>{t("terminal.agentHintDatabase")}</span>
                  </div>
                  <div className="tw:flex tw:items-center tw:gap-2">
                    <Icon name="file" />
                    <span>{t("terminal.agentHintAttachment")}</span>
                  </div>
                  <div className="tw:flex tw:items-center tw:gap-2">
                    <Icon name="check" />
                    <span>{t("terminal.agentHintSafety")}</span>
                  </div>
                </div>
              ) : (
                <>
                  <Icon name="terminal" />
                  <strong>{t("terminal.emptyTitle")}</strong>
                  <p>{t("terminal.emptyBody")}</p>
                </>
              )}
              {presentation !== "agent" ? (
                <TerminalEmptyActions
                  creatingProfile={state.creatingProfile}
                  presentation={presentation}
                  onCreate={(profile) => void createSession(profile)}
                />
              ) : null}
            </TerminalEmpty>
          ) : active ? (
            <TerminalSurface
              key={active.id}
              session={active}
              active
              registerOutput={registerOutput}
              onError={reportError}
            />
          ) : (
            <TerminalEmpty>{t("terminal.noSelection")}</TerminalEmpty>
          )}
        </div>
        {presentation === "agent" ? (
          <ToolWindowComposerDock>
            <ToolWindowComposer
              aria-label={t("terminal.agentComposer")}
              onSubmit={submitAgentPrompt}
            >
              {agentAttachments.length > 0 ? (
                <div className="tw:flex tw:flex-wrap tw:gap-1 tw:border-b tw:border-border-subtle tw:px-2 tw:py-1">
                  {agentAttachments.map((attachment) => (
                    <span
                      key={attachment}
                      className="tw:inline-flex tw:h-control-sm tw:items-center tw:gap-1 tw:rounded-xs tw:bg-muted tw:px-2 tw:text-xs tw:text-foreground"
                    >
                      <Icon
                        name={
                          attachment === "database" ? "database" : "file"
                        }
                      />
                      {attachment === "database"
                        ? connection.name || t("app.unnamed")
                        : attachableDocument?.kind === "sql"
                          ? attachableDocument.title
                          : t("terminal.agentDocument")}
                      <button
                        type="button"
                        className="tw:grid tw:size-4 tw:cursor-pointer tw:place-items-center tw:rounded-xs tw:border-0 tw:bg-transparent tw:p-0 tw:text-muted-foreground tw:hover:bg-background tw:hover:text-foreground"
                        onClick={() => removeAgentContext(attachment)}
                        title={t("terminal.agentRemoveContext")}
                        aria-label={t("terminal.agentRemoveContext")}
                      >
                        <Icon name="close" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <ToolWindowComposerInput
                value={agentPrompt}
                maxLength={AGENT_PROMPT_MAX_CHARS}
                placeholder={t("terminal.agentPrompt")}
                aria-label={t("terminal.agentPrompt")}
                onChange={(event) => {
                  setAgentPrompt(event.target.value);
                  if (event.target.value.endsWith("@")) {
                    setAgentAttachmentMenuOpen(true);
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Escape" &&
                    agentAttachmentMenuOpen
                  ) {
                    event.preventDefault();
                    setAgentAttachmentMenuOpen(false);
                    return;
                  }
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
                <button
                  type="button"
                  className="btn small icon-only"
                  onClick={() =>
                    setAgentAttachmentMenuOpen((open) => !open)
                  }
                  title={t("terminal.agentAddContext")}
                  aria-label={t("terminal.agentAddContext")}
                  aria-haspopup="menu"
                  aria-expanded={agentAttachmentMenuOpen}
                >
                  <Icon name="plus" />
                </button>
                <Icon
                  name="database"
                  className="tw:text-sm tw:text-muted-foreground"
                />
                <span className="tw:text-xs tw:text-muted-foreground">
                  {t("terminal.agentContextCount", {
                    count: agentAttachments.length,
                  })}
                </span>
                <span className="tw:flex-1" />
                <button
                  type="submit"
                  className="btn small icon-only"
                  disabled={
                    !agentPrompt.trim() ||
                    sendingAgentPrompt ||
                    state.creatingProfile !== null
                  }
                  title={t("terminal.agentSend")}
                  aria-label={t("terminal.agentSend")}
                >
                  <Icon name="send" />
                </button>
              </div>
              {agentAttachmentMenuOpen ? (
                <div
                  className="tw:absolute tw:right-2 tw:bottom-control-lg tw:left-2 tw:z-[var(--ds-z-popover)] tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-strong tw:bg-popover tw:shadow-popover"
                  role="menu"
                  aria-label={t("terminal.agentAddContext")}
                >
                  <button
                    type="button"
                    className="tw:flex tw:min-h-control-lg tw:cursor-pointer tw:items-center tw:gap-2 tw:border-0 tw:bg-transparent tw:px-3 tw:font-sans tw:text-left tw:text-sm tw:text-foreground tw:hover:bg-muted"
                    onClick={() => attachAgentContext("database")}
                    role="menuitem"
                  >
                    <Icon name="database" />
                    <span className="tw:min-w-0 tw:flex-1">
                      <strong className="tw:block tw:font-medium">
                        {t("terminal.agentDatabase")}
                      </strong>
                      <small className="tw:block tw:overflow-hidden tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
                        {connection.name || t("app.unnamed")} ·{" "}
                        {connection.database}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="tw:flex tw:min-h-control-lg tw:cursor-pointer tw:items-center tw:gap-2 tw:border-0 tw:border-t tw:border-border-subtle tw:bg-transparent tw:px-3 tw:font-sans tw:text-left tw:text-sm tw:text-foreground tw:disabled:cursor-not-allowed tw:disabled:opacity-50 tw:hover:bg-muted"
                    disabled={!attachableDocument}
                    onClick={() => attachAgentContext("document")}
                    role="menuitem"
                  >
                    <Icon name="file" />
                    <span className="tw:min-w-0 tw:flex-1">
                      <strong className="tw:block tw:font-medium">
                        {t("terminal.agentDocument")}
                      </strong>
                      <small className="tw:block tw:overflow-hidden tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
                        {attachableDocument?.kind === "sql"
                          ? attachableDocument.title
                          : t("terminal.agentNoDocument")}
                      </small>
                    </span>
                  </button>
                </div>
              ) : null}
            </ToolWindowComposer>
            <ToolWindowComposerContext>
              <Icon
                name="user"
                className="tw:text-sm tw:text-muted-foreground"
              />
              <select
                className="tw:h-control-md tw:min-w-0 tw:cursor-pointer tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-1 tw:font-sans tw:text-sm tw:text-foreground tw:outline-none tw:hover:bg-muted"
                value={agentProfile}
                aria-label={t("terminal.agentModel")}
                onChange={(event) =>
                  setAgentProfile(event.target.value as AgentProfile)
                }
              >
                <option value="codex">{t("terminal.codex")}</option>
                <option value="claude">{t("terminal.claude")}</option>
              </select>
              <span className="tw:flex-1" />
              <span className="tw:text-xs tw:text-muted-foreground">
                {t("terminal.pinned", {
                  name: connection.name || t("app.unnamed"),
                })}
              </span>
            </ToolWindowComposerContext>
          </ToolWindowComposerDock>
        ) : null}
      </aside>

    </>
  );
}
