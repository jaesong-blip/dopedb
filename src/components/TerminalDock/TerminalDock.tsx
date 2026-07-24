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
import {
  terminalCreate,
  terminalFocus,
  terminalKill,
  terminalList,
  terminalOutputChannel,
  terminalRename,
  terminalRestart,
} from "../../ipc/commands";
import type {
  ConnectionProfile,
  SkillInstallState,
  SkillStatus,
  TerminalOutputChunk,
  TerminalProfile,
  TerminalSessionSummary,
  TerminalStateEvent,
} from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import { Icon } from "../Icon";
import { useI18n } from "../../lib/i18n";
import LegacyChatArchiveDialog from "./LegacyChatArchiveDialog";
import TerminalContextBar from "./TerminalContextBar";
import TerminalSurface from "./TerminalSurface";
import TerminalTabs, { TerminalEmptyActions } from "./TerminalTabs";
import TerminalToolbar from "./TerminalToolbar";
import {
  initialTerminalDockState,
  terminalConnectionMismatch,
  terminalDockReducer,
} from "./terminalState";
import "./terminalDock.css";

const DEFAULT_DOCK_WIDTH = 480;
const MIN_DOCK_WIDTH = 360;
const MAX_DOCK_WIDTH = 720;
const OUTPUT_REPLAY_BYTES = 512 * 1024;

type OutputWriter = (chunk: TerminalOutputChunk) => void;

interface TerminalDockProps {
  connection: ConnectionProfile;
  skillStatus: SkillStatus | null;
  overlay: boolean;
  width: number;
  unseen: number;
  onWidthChange: (width: number) => void;
  onOpenLogs: () => void;
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

export default function TerminalDock({
  connection,
  skillStatus,
  overlay,
  width,
  unseen,
  onWidthChange,
  onOpenLogs,
  onClose,
}: TerminalDockProps) {
  const { t } = useI18n();
  const [state, dispatch] = useReducer(
    terminalDockReducer,
    initialTerminalDockState,
  );
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const dockRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const archiveButtonRef = useRef<HTMLButtonElement>(null);
  const currentConnectionIdRef = useRef(connection.id);
  const channelsRef = useRef(
    new Map<string, ReturnType<typeof terminalOutputChannel>>(),
  );
  const writersRef = useRef(new Map<string, OutputWriter>());
  const replayRef = useRef(new Map<string, TerminalOutputChunk[]>());
  const replayBytesRef = useRef(new Map<string, number>());
  const lastSequenceRef = useRef(new Map<string, number>());
  const retiredRef = useRef(new Set<string>());
  currentConnectionIdRef.current = connection.id;

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
    (id: string) => {
      const existing = channelsRef.current.get(id);
      if (existing) return existing;
      const channel = makeChannel();
      channelsRef.current.set(id, channel);
      return channel;
    },
    [makeChannel],
  );

  const attachSession = useCallback(
    async (id: string) => {
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
    (id: string, writer: OutputWriter | null) => {
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

  const active = useMemo(
    () => state.sessions.find((session) => session.id === state.activeId) ?? null,
    [state.activeId, state.sessions],
  );
  const mismatch =
    active !== null && terminalConnectionMismatch(active, connection.id);
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

  async function restartSession(session: TerminalSessionSummary) {
    dispatch({ type: "error", error: null });
    const channel = makeChannel();
    try {
      const next = await terminalRestart(session.id, channel);
      retiredRef.current.add(session.id);
      channelsRef.current.delete(session.id);
      channelsRef.current.set(next.id, channel);
      writersRef.current.delete(session.id);
      replayRef.current.delete(session.id);
      replayBytesRef.current.delete(session.id);
      lastSequenceRef.current.delete(session.id);
      dispatch({ type: "replace", previousId: session.id, session: next });
    } catch (error) {
      dispatch({ type: "error", error: errMessage(error) });
      await loadSessions();
    }
  }

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
        <TerminalToolbar
          sessionCount={state.sessions.length}
          unseen={unseen}
          maximized={maximized}
          archiveButtonRef={archiveButtonRef}
          closeButtonRef={closeRef}
          onOpenArchive={() => setArchiveOpen(true)}
          onOpenActivity={onOpenLogs}
          onToggleMaximize={() => setMaximized((value) => !value)}
          onClose={onClose}
        />

        <TerminalTabs
          sessions={state.sessions}
          activeId={state.activeId}
          creatingProfile={state.creatingProfile}
          profileMenuOpen={profileMenuOpen}
          onActivate={(id) => dispatch({ type: "activate", id })}
          onToggleProfileMenu={() => setProfileMenuOpen((open) => !open)}
          onCreate={(profile) => void createSession(profile)}
        />

        {state.error && (
          <div className="terminal-notice danger" role="alert">
            <Icon name="alert" />
            <span>{state.error}</span>
            <button
              type="button"
              className="btn small"
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
            connection={connection}
            skillState={activeSkillState}
            mismatch={mismatch}
            replayTruncated={state.replayTruncated.includes(active.id)}
            creatingProfile={state.creatingProfile}
            onRename={() => void renameSession(active)}
            onStop={() => void stopSession(active)}
            onRestart={() => void restartSession(active)}
            onCreateForCurrent={() => void createSession(active.profile)}
          />
        )}

        <div className="terminal-dock-body">
          {state.loading ? (
            <div className="terminal-empty">
              <span className="loading">{t("common.loading")}</span>
            </div>
          ) : state.sessions.length === 0 ? (
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
