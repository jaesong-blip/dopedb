// Workspace-scoped Terminal chrome keeps its clipped tab strip separate from one
// portal popup layer, so tab actions remain reachable at every dock width.
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { TerminalCloseAction } from "../../features/terminals/commands";
import type {
  TerminalProfile,
  TerminalSessionId,
  TerminalSessionSummary,
} from "../../features/terminals/domain";
import { terminalPopupPosition } from "../../features/terminals/layout";
import { Icon } from "../Icon";
import { useI18n } from "../../lib/i18n";

export type TerminalPopup =
  | { kind: "profile"; trigger: HTMLElement; rect: DOMRect }
  | {
      kind: "tab";
      targetId: TerminalSessionId;
      trigger: HTMLElement;
      rect: DOMRect;
    };

interface TerminalTabsProps {
  sessions: TerminalSessionSummary[];
  activeId: TerminalSessionId | null;
  creatingProfile: TerminalProfile | null;
  closingId: TerminalSessionId | null;
  maximized: boolean;
  popup: TerminalPopup | null;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onActivate: (id: TerminalSessionId) => void;
  onCloseAction: (id: TerminalSessionId, action: TerminalCloseAction) => void;
  onOpenPopup: (popup: TerminalPopup) => void;
  onDismissPopup: () => void;
  onCreate: (profile: TerminalProfile) => void;
  onToggleMaximize: () => void;
  onPanelClose: () => void;
}

interface TerminalProfileOption {
  id: TerminalProfile;
  label: string;
  hint: string;
}

interface TerminalPopupFocusRequest {
  currentIndex: number;
  itemCount: number;
  key: string;
  shiftKey: boolean;
}

export function terminalProfileIcon(profile: TerminalProfile) {
  return profile === "shell" ? "terminal" : "user";
}

/** The popup owns arrow navigation and traps Tab while its portal is open. */
export function terminalPopupFocusIndex({
  currentIndex,
  itemCount,
  key,
  shiftKey,
}: TerminalPopupFocusRequest): number | null {
  if (itemCount === 0) return null;
  const current = currentIndex < 0 ? 0 : currentIndex;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown" || (key === "Tab" && !shiftKey)) {
    return (current + 1) % itemCount;
  }
  if (key === "ArrowUp" || (key === "Tab" && shiftKey)) {
    return (current - 1 + itemCount) % itemCount;
  }
  return null;
}

function popupPosition(rect: DOMRect, height: number) {
  return terminalPopupPosition(
    rect,
    { width: 272, height },
    { width: window.innerWidth, height: window.innerHeight },
  );
}

function TerminalActionPopup({
  popup,
  sessions,
  profiles,
  creatingProfile,
  onDismiss,
  onCreate,
  onCloseAction,
}: {
  popup: TerminalPopup;
  sessions: TerminalSessionSummary[];
  profiles: TerminalProfileOption[];
  creatingProfile: TerminalProfile | null;
  onDismiss: () => void;
  onCreate: (profile: TerminalProfile) => void;
  onCloseAction: (id: TerminalSessionId, action: TerminalCloseAction) => void;
}) {
  const { t } = useI18n();
  const popupRef = useRef<HTMLDivElement>(null);
  const targetIndex = popup.kind === "tab"
    ? sessions.findIndex((session) => session.id === popup.targetId)
    : -1;
  const style = popupPosition(popup.rect, popup.kind === "profile" ? 184 : 132);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() =>
      popupRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus(),
    );
    const pointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !popupRef.current?.contains(event.target) &&
        !popup.trigger.contains(event.target)
      ) {
        onDismiss();
      }
    };
    document.addEventListener("pointerdown", pointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", pointerDown);
    };
  }, [onDismiss, popup]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    const nextKeys = ["Tab", "ArrowDown", "ArrowUp", "Home", "End"];
    if (!nextKeys.includes(event.key)) return;
    const items = Array.from(
      popupRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? [],
    );
    const next = terminalPopupFocusIndex({
      currentIndex: items.indexOf(document.activeElement as HTMLButtonElement),
      itemCount: items.length,
      key: event.key,
      shiftKey: event.shiftKey,
    });
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  }

  return createPortal(
    <div
      ref={popupRef}
      className="terminal-action-popup"
      data-terminal-popup
      role="menu"
      style={{ left: style.left, top: style.top, width: style.width }}
      onKeyDown={handleKeyDown}
    >
      {popup.kind === "profile" ? (
        profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            role="menuitem"
            disabled={creatingProfile !== null}
            onClick={() => onCreate(profile.id)}
          >
            <Icon name={terminalProfileIcon(profile.id)} />
            <span>
              <strong>{profile.label}</strong>
              <small>{profile.hint}</small>
            </span>
          </button>
        ))
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => onCloseAction(popup.targetId, "one")}
          >
            {t("terminal.closeSession")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={targetIndex < 0 || sessions.length < 2}
            onClick={() => onCloseAction(popup.targetId, "others")}
          >
            {t("terminal.closeOthers")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={targetIndex < 0 || targetIndex === sessions.length - 1}
            onClick={() => onCloseAction(popup.targetId, "right")}
          >
            {t("terminal.closeRight")}
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

export default function TerminalTabs({
  sessions,
  activeId,
  creatingProfile,
  closingId,
  maximized,
  popup,
  closeButtonRef,
  onActivate,
  onCloseAction,
  onOpenPopup,
  onDismissPopup,
  onCreate,
  onToggleMaximize,
  onPanelClose,
}: TerminalTabsProps) {
  const { t } = useI18n();
  const profiles: TerminalProfileOption[] = [
    { id: "shell", label: t("terminal.shell"), hint: t("terminal.shellHint") },
    { id: "codex", label: t("terminal.codex"), hint: t("terminal.codexHint") },
    { id: "claude", label: t("terminal.claude"), hint: t("terminal.claudeHint") },
  ];

  function activateTab(index: number) {
    const session = sessions[index];
    if (!session) return;
    onActivate(session.id);
    window.requestAnimationFrame(() =>
      document.getElementById(`terminal-tab-${session.id}`)?.focus(),
    );
  }

  function openTabPopup(
    session: TerminalSessionSummary,
    trigger: HTMLButtonElement,
  ) {
    onOpenPopup({
      kind: "tab",
      targetId: session.id,
      trigger,
      rect: trigger.getBoundingClientRect(),
    });
  }

  return (
    <header className="terminal-tabs-row">
      <div
        className="terminal-session-tabs ds-control-row"
        role="tablist"
        aria-label={t("terminal.sessions")}
      >
        {sessions.length === 0 && (
          <div className="terminal-tabs-empty-label">
            <Icon name="terminal" />
            <strong>{t("terminal.title")}</strong>
          </div>
        )}
        {sessions.map((session, index) => (
          <div
            key={session.id}
            className={`terminal-session-tab${
              session.id === activeId ? " active" : ""
            }`}
            aria-busy={closingId === session.id}
          >
            <button
              id={`terminal-tab-${session.id}`}
              type="button"
              className="terminal-session-select"
              role="tab"
              aria-selected={session.id === activeId}
              aria-controls={
                session.id === activeId
                  ? `terminal-panel-${session.id}`
                  : undefined
              }
              tabIndex={session.id === activeId ? 0 : -1}
              data-terminal-focus-target={
                session.id === activeId ? "active-session" : undefined
              }
              onClick={() => onActivate(session.id)}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                onCloseAction(session.id, "one");
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                openTabPopup(session, event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  activateTab((index - 1 + sessions.length) % sessions.length);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  activateTab((index + 1) % sessions.length);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  activateTab(0);
                } else if (event.key === "End") {
                  event.preventDefault();
                  activateTab(sessions.length - 1);
                }
              }}
              title={`${session.name} · ${session.connection.connectionName}`}
            >
              <span
                className={`terminal-status-dot ${session.lifecycle}`}
                aria-hidden="true"
              />
              <span>{session.name}</span>
            </button>
            <button
              type="button"
              className="terminal-session-close"
              disabled={closingId === session.id}
              onClick={() => onCloseAction(session.id, "one")}
              title={t("terminal.closeSession")}
              aria-label={`${t("terminal.closeSession")}: ${session.name}`}
            >
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
      <div className="terminal-window-actions ds-control-row">
        <button
          type="button"
          className="btn small icon-only"
          data-terminal-focus-target="launcher"
          onClick={(event) =>
            onOpenPopup({
              kind: "profile",
              trigger: event.currentTarget,
              rect: event.currentTarget.getBoundingClientRect(),
            })
          }
          title={t("terminal.newSession")}
          aria-label={t("terminal.newSession")}
          aria-haspopup="menu"
          aria-expanded={popup?.kind === "profile"}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          disabled={sessions.length === 0}
          onClick={(event) => {
            const target = sessions.find((session) => session.id === activeId);
            if (target) openTabPopup(target, event.currentTarget);
          }}
          title={t("terminal.tabActions")}
          aria-label={t("terminal.tabActions")}
          aria-haspopup="menu"
          aria-expanded={popup?.kind === "tab"}
        >
          <Icon name="moreVertical" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          onClick={onToggleMaximize}
          title={maximized ? t("terminal.restore") : t("terminal.maximize")}
          aria-label={maximized ? t("terminal.restore") : t("terminal.maximize")}
          aria-pressed={maximized}
        >
          <Icon name={maximized ? "minimize" : "maximize"} />
        </button>
        <button
          ref={closeButtonRef}
          type="button"
          className="btn small icon-only"
          onClick={onPanelClose}
          title={t("terminal.closePanel")}
          aria-label={t("terminal.closePanel")}
        >
          <Icon name="close" />
        </button>
      </div>
      {popup && (
        <TerminalActionPopup
          popup={popup}
          sessions={sessions}
          profiles={profiles}
          creatingProfile={creatingProfile}
          onDismiss={onDismissPopup}
          onCreate={(profile) => {
            onDismissPopup();
            onCreate(profile);
          }}
          onCloseAction={(id, action) => {
            onDismissPopup();
            onCloseAction(id, action);
          }}
        />
      )}
    </header>
  );
}

export function TerminalEmptyActions({
  creatingProfile,
  onCreate,
}: {
  creatingProfile: TerminalProfile | null;
  onCreate: (profile: TerminalProfile) => void;
}) {
  const { t } = useI18n();
  const profiles: Array<{ id: TerminalProfile; label: string }> = [
    { id: "shell", label: t("terminal.shell") },
    { id: "codex", label: t("terminal.codex") },
    { id: "claude", label: t("terminal.claude") },
  ];

  return (
    <div className="terminal-empty-actions ds-control-row">
      {profiles.map((profile) => (
        <button
          key={profile.id}
          type="button"
          className="btn"
          disabled={creatingProfile !== null}
          onClick={() => onCreate(profile.id)}
        >
          <Icon name={terminalProfileIcon(profile.id)} />
          {creatingProfile === profile.id ? t("terminal.creating") : profile.label}
        </button>
      ))}
    </div>
  );
}
