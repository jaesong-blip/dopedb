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
import { Button } from "../../design-system/components/Button";
import { StatusDot, type StatusTone } from "../../design-system/components/Status";
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

export type TerminalPresentation = "terminal" | "agent";

interface TerminalTabsProps {
  sessions: TerminalSessionSummary[];
  activeId: TerminalSessionId | null;
  creatingProfile: TerminalProfile | null;
  closingId: TerminalSessionId | null;
  maximized: boolean;
  popup: TerminalPopup | null;
  presentation: TerminalPresentation;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onActivate: (id: TerminalSessionId) => void;
  onCloseAction: (id: TerminalSessionId, action: TerminalCloseAction) => void;
  onOpenPopup: (popup: TerminalPopup) => void;
  onDismissPopup: () => void;
  onCreate: (profile: TerminalProfile) => void;
  onToggleMaximize: () => void;
  onOpenArchive: () => void;
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

export function terminalLifecycleTone(
  lifecycle: TerminalSessionSummary["lifecycle"],
): StatusTone {
  if (lifecycle === "running") return "success";
  if (lifecycle === "starting" || lifecycle === "stopping") return "warning";
  if (lifecycle === "failed") return "danger";
  return "neutral";
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
      className="tw:fixed tw:z-[var(--ds-z-popover)] tw:grid tw:min-w-[168px] tw:overflow-hidden tw:rounded-md tw:border tw:border-border-strong tw:bg-popover tw:shadow-popover tw:[&_button]:flex tw:[&_button]:min-h-control-lg tw:[&_button]:cursor-pointer tw:[&_button]:items-center tw:[&_button]:gap-3 tw:[&_button]:border-0 tw:[&_button]:bg-transparent tw:[&_button]:px-3 tw:[&_button]:font-sans tw:[&_button]:text-left tw:[&_button]:text-foreground tw:[&_button]:disabled:cursor-default tw:[&_button]:disabled:opacity-50 tw:[&_button]:hover:bg-muted tw:[&_button]:focus-visible:bg-muted tw:[&_button]:focus-visible:outline-none"
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
            <span className="tw:grid tw:min-w-0 tw:gap-[var(--ds-segment-gap)]">
              <strong>{profile.label}</strong>
              <small className="tw:overflow-hidden tw:text-xs tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
                {profile.hint}
              </small>
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
  presentation,
  closeButtonRef,
  onActivate,
  onCloseAction,
  onOpenPopup,
  onDismissPopup,
  onCreate,
  onToggleMaximize,
  onOpenArchive,
  onPanelClose,
}: TerminalTabsProps) {
  const { t } = useI18n();
  const allProfiles: TerminalProfileOption[] = [
    { id: "shell", label: t("terminal.shell"), hint: t("terminal.shellHint") },
    { id: "codex", label: t("terminal.codex"), hint: t("terminal.codexHint") },
    { id: "claude", label: t("terminal.claude"), hint: t("terminal.claudeHint") },
  ];
  const profiles =
    presentation === "agent"
      ? allProfiles.filter((profile) => profile.id !== "shell")
      : allProfiles;

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
    <header className="terminal-tabs-row tw:relative tw:flex tw:h-tool-window-header tw:min-h-tool-window-header tw:shrink-0 tw:items-stretch tw:gap-1 tw:border-b tw:border-border-subtle tw:bg-background tw:p-1">
      <div
        className="terminal-session-tabs ds-control-row tw:relative tw:flex tw:min-h-control-lg tw:min-w-0 tw:flex-1 tw:items-stretch tw:overflow-x-auto tw:[scrollbar-width:thin]"
        role="tablist"
        aria-label={t(
          presentation === "agent"
            ? "terminal.agentSessions"
            : "terminal.sessions",
        )}
      >
        {sessions.length === 0 && (
          <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:px-2 tw:text-muted-foreground tw:[&_strong]:text-foreground">
            {presentation === "terminal" ? <Icon name="terminal" /> : null}
            <strong>
              {t(
                presentation === "agent"
                  ? "terminal.agentTitle"
                  : "terminal.title",
              )}
            </strong>
          </div>
        )}
        {sessions.map((session, index) => (
          <div
            key={session.id}
            data-active={session.id === activeId}
            className="tw:group tw:flex tw:min-h-control-lg tw:min-w-[112px] tw:max-w-[196px] tw:flex-[0_1_164px] tw:items-center tw:border-r tw:border-border-subtle tw:bg-transparent tw:text-muted-foreground tw:aria-busy:opacity-60 tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:data-[active=true]:shadow-[inset_0_-2px_0_var(--ds-selection-foreground)] tw:hover:bg-muted tw:hover:text-foreground"
            aria-busy={closingId === session.id}
          >
            <button
              id={`terminal-tab-${session.id}`}
              type="button"
              className="tw:flex tw:min-h-control-lg tw:min-w-0 tw:flex-1 tw:cursor-pointer tw:items-center tw:gap-2 tw:border-0 tw:bg-transparent tw:py-0 tw:pr-1 tw:pl-3 tw:font-sans tw:text-inherit tw:focus-visible:relative tw:focus-visible:z-[var(--ds-z-base)] tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-inset tw:focus-visible:ring-ring tw:[&>span:last-child]:overflow-hidden tw:[&>span:last-child]:text-ellipsis tw:[&>span:last-child]:whitespace-nowrap"
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
              <StatusDot tone={terminalLifecycleTone(session.lifecycle)} />
              <span>{session.name}</span>
            </button>
            <button
              type="button"
              className="tw:mr-1 tw:grid tw:size-control-sm tw:shrink-0 tw:cursor-pointer tw:place-items-center tw:rounded-xs tw:border-0 tw:bg-transparent tw:p-0 tw:text-transparent tw:transition-colors tw:disabled:cursor-wait tw:group-data-[active=true]:text-muted-foreground tw:group-hover:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground tw:focus-visible:relative tw:focus-visible:z-[var(--ds-z-base)] tw:focus-visible:text-muted-foreground tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-inset tw:focus-visible:ring-ring tw:[&_.icon]:size-[var(--ds-icon-sm)]"
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
      <div className="ds-control-row tw:flex tw:shrink-0 tw:self-center">
        <Button
          iconOnly={presentation !== "agent"}
          size="compact"
          variant="ghost"
          data-terminal-focus-target="launcher"
          onClick={(event) =>
            onOpenPopup({
              kind: "profile",
              trigger: event.currentTarget,
              rect: event.currentTarget.getBoundingClientRect(),
            })
          }
          title={t(
            presentation === "agent"
              ? "terminal.newChat"
              : "terminal.newSession",
          )}
          aria-label={t(
            presentation === "agent"
              ? "terminal.newChat"
              : "terminal.newSession",
          )}
          aria-haspopup="menu"
          aria-expanded={popup?.kind === "profile"}
        >
          <Icon name="plus" />
          {presentation === "agent" ? t("terminal.newChat") : null}
        </Button>
        {presentation === "agent" && (
          <Button
            iconOnly
            size="compact"
            variant="ghost"
            onClick={onOpenArchive}
            title={t("terminal.openArchive")}
            aria-label={t("terminal.openArchive")}
          >
            <Icon name="history" />
          </Button>
        )}
        {sessions.length > 0 ? (
          <Button
            iconOnly
            size="compact"
            variant="ghost"
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
          </Button>
        ) : null}
        {presentation !== "agent" && (
          <Button
            iconOnly
            size="compact"
            variant="ghost"
            onClick={onToggleMaximize}
            title={maximized ? t("terminal.restore") : t("terminal.maximize")}
            aria-label={maximized ? t("terminal.restore") : t("terminal.maximize")}
            aria-pressed={maximized}
          >
            <Icon name={maximized ? "minimize" : "maximize"} />
          </Button>
        )}
        <Button
          ref={closeButtonRef}
          iconOnly
          size="compact"
          variant="ghost"
          onClick={onPanelClose}
          title={t(
            presentation === "agent"
              ? "terminal.closeAgentPanel"
              : "terminal.closePanel",
          )}
          aria-label={t(
            presentation === "agent"
              ? "terminal.closeAgentPanel"
              : "terminal.closePanel",
          )}
        >
          <Icon name="minus" />
        </Button>
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
  presentation = "terminal",
  onCreate,
}: {
  creatingProfile: TerminalProfile | null;
  presentation?: TerminalPresentation;
  onCreate: (profile: TerminalProfile) => void;
}) {
  const { t } = useI18n();
  const allProfiles: Array<{ id: TerminalProfile; label: string }> = [
    { id: "shell", label: t("terminal.shell") },
    { id: "codex", label: t("terminal.codex") },
    { id: "claude", label: t("terminal.claude") },
  ];
  const profiles =
    presentation === "agent"
      ? allProfiles.filter((profile) => profile.id !== "shell")
      : allProfiles;

  return (
    <div className="ds-control-row tw:flex tw:flex-wrap tw:justify-center">
      {profiles.map((profile) => (
        <Button
          key={profile.id}
          disabled={creatingProfile !== null}
          onClick={() => onCreate(profile.id)}
        >
          <Icon name={terminalProfileIcon(profile.id)} />
          {creatingProfile === profile.id ? t("terminal.creating") : profile.label}
        </Button>
      ))}
    </div>
  );
}
