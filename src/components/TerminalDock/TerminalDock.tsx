// Persistent PTY dock controller: owns session tabs, bounded replay routing,
// focus containment, and connection-pinned lifecycle actions.
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  SkillInstallState,
  SkillStatus,
} from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import {
  connectionId,
  type ConnectionProfile,
} from "../../features/connections/domain";
import {
  terminalClose,
  terminalCreate,
  terminalFocus,
  terminalKill,
  terminalList,
  terminalOutputChannel,
  terminalRename,
  terminalRestart,
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
  terminalActiveIdForConnection,
  terminalDockReducer,
  terminalSessionIsRunning,
  terminalSessionsForConnection,
  type TerminalDockState,
} from "../../features/terminals/state";
import { Icon } from "../Icon";
import LegacyChatArchiveDialog from "./LegacyChatArchiveDialog";
import TerminalContextBar from "./TerminalContextBar";
import TerminalSurface from "./TerminalSurface";
import TerminalTabs, { TerminalEmptyActions } from "./TerminalTabs";
import { useI18n } from "../../lib/i18n";
import "./terminalDock.css";

const DEFAULT_DOCK_WIDTH = 480;
const MIN_DOCK_WIDTH = 360;
const MAX_DOCK_WIDTH = 720;
const OUTPUT_REPLAY_BYTES = 512 * 1024;
const ACTIVE_SESSION_STORAGE = "terminalActiveSessionByConnection";

type OutputWriter = (chunk: TerminalOutputChunk) => void;

interface TerminalDockProps {
  connection: ConnectionProfile;
  skillStatus: SkillStatus | null;
  overlay: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}

function clampDockWidth(width: number): number {
  const viewportMaximum = Math.max(
    MIN_DOCK_WIDTH,
    Math.floor(window.innerWidth * 0.55),
  );
  return Math.round(
    Math.min(MAX_DOCK_WIDTH, viewportMaximum, Math.max(MIN_DOCK_WIDTH, width)),
  );
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
    const activeIdByConnection: TerminalDockState["activeIdByConnection"] =
      {};
    for (const [id, sessionId] of Object.entries(parsed)) {
      if (typeof sessionId === "string") {
        activeIdByConnection[connectionId(id)] = terminalSessionId(sessionId);
      }
    }
    return { ...base, activeIdByConnection };
  } catch {
    return base;
  }
}

export default function TerminalDock({
  connection,
  skillStatus,
  overlay,
  width,
  onWidthChange,
  onClose,
}: TerminalDockProps) {
  const { t } = useI18n();
  const [state, dispatch] = useReducer(
    terminalDockReducer,
    initialTerminalDockState,
    restoreTerminalDockState,
  );
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [closingId, setClosingId] = useState<TerminalSessionId | null>(null);
  const dockRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const archiveButtonRef = useRef<HTMLButtonElement>(null);
  const currentConnectionIdRef = useRef(connection.id);
  const channelsRef = useRef(
    new Map<TerminalSessionId, ReturnType<typeof terminalOutputChannel>>(),
  );
  const writersRef = useRef(new Map<TerminalSessionId, OutputWriter>());
  const replayRef = useRef(new Map<TerminalSessionId, TerminalOutputChunk[]>());
  const replayBytesRef = useRef(new Map<TerminalSessionId, number>());
  const lastSequenceRef = useRef(new Map<TerminalSessionId, number>());
  const retiredRef = useRef(new Set<TerminalSessionId>());
  currentConnectionIdRef.current = connection.id;

  useEffect(() => {
    localStorage.setItem(
      ACTIVE_SESSION_STORAGE,
      JSON.stringify(state.activeIdByConnection),
    );
  }, [state.activeIdByConnection]);

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
        currentConnectionId: currentConnectionIdRef.current,
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
      const next = clampDockWidth(width);
      if (next !== width) onWidthChange(next);
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [onWidthChange, width]);

  useEffect(() => {
    const modal = overlay || maximized;
    if ((!modal && !profileMenuOpen) || archiveOpen) return;
    const inertTargets = modal
      ? [
          document.querySelector<HTMLElement>(".main"),
          document.querySelector<HTMLElement>(".sidebar"),
          document.querySelector<HTMLElement>(".workbench-rail"),
        ].filter((target): target is HTMLElement => target !== null)
      : [];
    inertTargets.forEach((target) => target.setAttribute("inert", ""));
    const frame = window.requestAnimationFrame(() => {
      if (profileMenuOpen) {
        dockRef.current
          ?.querySelector<HTMLElement>('[role="menuitem"]')
          ?.focus();
      } else if (modal) {
        closeRef.current?.focus();
      }
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (profileMenuOpen) {
          setProfileMenuOpen(false);
          window.requestAnimationFrame(() =>
            dockRef.current
              ?.querySelector<HTMLElement>('[aria-haspopup="menu"]')
              ?.focus(),
          );
        } else if (maximized) {
          setMaximized(false);
        } else {
          onClose();
        }
        return;
      }
      if (
        profileMenuOpen &&
        ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
      ) {
        const items = Array.from(
          dockRef.current?.querySelectorAll<HTMLElement>(
            '[role="menuitem"]:not(:disabled)',
          ) ?? [],
        );
        if (items.length === 0) return;
        event.preventDefault();
        const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : event.key === "ArrowDown"
                ? (current + 1) % items.length
                : (current - 1 + items.length) % items.length;
        items[index]?.focus();
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
    const handlePointerDown = (event: PointerEvent) => {
      if (
        profileMenuOpen &&
        event.target instanceof Node &&
        !dockRef.current
          ?.querySelector(".terminal-profile-menu-wrap")
          ?.contains(event.target)
      ) {
        setProfileMenuOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      inertTargets.forEach((target) => target.removeAttribute("inert"));
    };
  }, [archiveOpen, maximized, onClose, overlay, profileMenuOpen]);

  const visibleSessions = useMemo(
    () => terminalSessionsForConnection(state.sessions, connection.id),
    [connection.id, state.sessions],
  );
  const activeId = terminalActiveIdForConnection(state, connection.id);
  const active = useMemo(
    () =>
      visibleSessions.find((session) => session.id === activeId) ?? null,
    [activeId, visibleSessions],
  );
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

  async function createSession(profile: TerminalProfile) {
    setProfileMenuOpen(false);
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
    } catch (error) {
      dispatch({
        type: "error",
        error: t("terminal.createFailed", { error: errMessage(error) }),
      });
    } finally {
      dispatch({ type: "creating", profile: null });
    }
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

  const closeSession = useCallback(
    async (session: TerminalSessionSummary) => {
      if (closingId) return;
      if (
        terminalSessionIsRunning(session) &&
        !window.confirm(t("terminal.closeConfirm"))
      ) {
        return;
      }
      setClosingId(session.id);
      dispatch({ type: "error", error: null });
      retireSessionResources(session.id);
      try {
        await terminalClose(session.id);
        dispatch({ type: "remove", id: session.id });
        window.requestAnimationFrame(() => {
          dockRef.current
            ?.querySelector<HTMLButtonElement>(
              '.terminal-session-select[aria-selected="true"]',
            )
            ?.focus();
        });
      } catch (error) {
        retiredRef.current.delete(session.id);
        dispatch({
          type: "error",
          error: t("terminal.closeFailed", { error: errMessage(error) }),
        });
        await loadSessions();
      } finally {
        setClosingId(null);
      }
    },
    [closingId, loadSessions, retireSessionResources, t],
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
      if (
        !active ||
        event.key.toLowerCase() !== "w" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        !dockRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      const terminalInput =
        event.target instanceof Element &&
        event.target.closest(".xterm") !== null;
      if (event.ctrlKey && !event.metaKey && terminalInput) return;
      event.preventDefault();
      void closeSession(active);
    };
    document.addEventListener("keydown", handleCloseShortcut);
    return () =>
      document.removeEventListener("keydown", handleCloseShortcut);
  }, [active, closeSession]);

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
      onWidthChange(clampDockWidth(startWidth + startX - next.clientX));
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
        className={`terminal-dock${maximized ? " maximized" : ""}`}
        aria-label={t("terminal.title")}
        role={overlay || maximized ? "dialog" : undefined}
        aria-modal={overlay || maximized || undefined}
      >
        <div
          className="terminal-dock-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("app.dragResize")}
          onMouseDown={beginResize}
          onDoubleClick={() => onWidthChange(DEFAULT_DOCK_WIDTH)}
        />
        <TerminalTabs
          sessions={visibleSessions}
          activeId={activeId}
          creatingProfile={state.creatingProfile}
          closingId={closingId}
          profileMenuOpen={profileMenuOpen}
          maximized={maximized}
          archiveButtonRef={archiveButtonRef}
          closeButtonRef={closeRef}
          onActivate={(id) => dispatch({ type: "activate", id })}
          onClose={(session) => void closeSession(session)}
          onToggleProfileMenu={() => setProfileMenuOpen((open) => !open)}
          onCreate={(profile) => void createSession(profile)}
          onOpenArchive={() => setArchiveOpen(true)}
          onToggleMaximize={() => setMaximized((value) => !value)}
          onPanelClose={onClose}
        />

        {state.error && (
          <div className="terminal-notice danger" role="alert">
            <Icon name="alert" />
            <span>{state.error}</span>
            <button
              type="button"
              className="btn small icon-only icon-xs"
              onClick={() => dispatch({ type: "error", error: null })}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <Icon name="close" />
            </button>
          </div>
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

        <div className="terminal-dock-body">
          {state.loading ? (
            <div className="terminal-empty">
              <span className="loading">{t("common.loading")}</span>
            </div>
          ) : visibleSessions.length === 0 ? (
            <div className="terminal-empty">
              <Icon name="terminal" />
              <strong>{t("terminal.emptyTitle")}</strong>
              <p>{t("terminal.emptyBody")}</p>
              <TerminalEmptyActions
                creatingProfile={state.creatingProfile}
                onCreate={(profile) => void createSession(profile)}
              />
            </div>
          ) : active ? (
            <TerminalSurface
              key={active.id}
              session={active}
              active
              registerOutput={registerOutput}
              onError={reportError}
            />
          ) : (
            <div className="terminal-empty">
              <span className="muted">{t("terminal.noSelection")}</span>
            </div>
          )}
        </div>
      </aside>

      {archiveOpen && (
        <LegacyChatArchiveDialog
          connection={connection}
          onClose={() => {
            setArchiveOpen(false);
            window.requestAnimationFrame(() =>
              archiveButtonRef.current?.focus(),
            );
          }}
        />
      )}
    </>
  );
}
