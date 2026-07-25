// Read-only bridge to conversations created before the PTY Terminal migration.
// It deliberately exposes no send, retry, or mutation controls.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { ConnectionProfile } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import { Icon } from "../Icon";
import {
  agentChatMessagesQuery,
  agentChatThreadsQuery,
} from "../../lib/queries";
import { useI18n } from "../../lib/i18n";

export default function LegacyChatArchiveDialog({
  connection,
  onClose,
}: {
  connection: ConnectionProfile;
  onClose: () => void;
}) {
  const { lang, t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const threadsQuery = useQuery(agentChatThreadsQuery());
  const threads = useMemo(
    () =>
      (threadsQuery.data ?? []).filter(
        (thread) => thread.connectionId === connection.id,
      ),
    [connection.id, threadsQuery.data],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeThread =
    threads.find((thread) => thread.id === activeId) ?? threads[0] ?? null;
  const messagesQuery = useQuery(
    agentChatMessagesQuery(activeThread?.id ?? null),
  );
  const date = useMemo(
    () =>
      new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [lang],
  );

  useEffect(() => {
    if (activeId && threads.some((thread) => thread.id === activeId)) return;
    setActiveId(threads[0]?.id ?? null);
  }, [activeId, threads]);

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>(".app");
    const appWasInert = app?.hasAttribute("inert") ?? false;
    app?.setAttribute("inert", "");
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      if (!appWasInert) app?.removeAttribute("inert");
      trigger?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="terminal-archive-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="terminal-archive-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-archive-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="terminal-archive-head">
          <div className="terminal-archive-heading">
            <Icon name="history" />
            <div>
              <strong id="terminal-archive-title">
                {t("terminal.archive")}
              </strong>
              <span>
                {connection.name || t("app.unnamed")} ·{" "}
                {t("terminal.archiveReadOnly")}
              </span>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn small icon-only icon-xs"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="terminal-archive-layout">
          <nav
            className="terminal-archive-list"
            aria-label={t("terminal.archive")}
          >
            {threadsQuery.isPending ? (
              <span className="muted">{t("common.loading")}</span>
            ) : threadsQuery.error ? (
              <span className="error" role="alert">
                {t("terminal.archiveLoadFailed", {
                  error: errMessage(threadsQuery.error),
                })}
              </span>
            ) : threads.length === 0 ? (
              <span className="muted">{t("terminal.archiveEmpty")}</span>
            ) : (
              threads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className="terminal-archive-thread"
                  aria-pressed={thread.id === activeThread?.id}
                  onClick={() => setActiveId(thread.id)}
                >
                  <strong>{thread.title}</strong>
                  <span>
                    {thread.provider === "codex"
                      ? t("terminal.codex")
                      : t("terminal.claude")}
                    {" · "}
                    {date.format(new Date(thread.updatedAt))}
                  </span>
                </button>
              ))
            )}
          </nav>

          <section
            className="terminal-archive-messages"
            aria-live="polite"
            aria-label={activeThread?.title ?? t("terminal.archive")}
          >
            {!activeThread ? null : messagesQuery.isPending ? (
              <span className="muted">{t("common.loading")}</span>
            ) : messagesQuery.error ? (
              <span className="error" role="alert">
                {t("terminal.archiveLoadFailed", {
                  error: errMessage(messagesQuery.error),
                })}
              </span>
            ) : (messagesQuery.data ?? []).length === 0 ? (
              <span className="muted">{t("terminal.archiveNoMessages")}</span>
            ) : (
              (messagesQuery.data ?? []).map((message) => (
                <article
                  key={message.id}
                  className={`terminal-archive-message ${message.role}`}
                >
                  <strong>
                    {message.role === "user"
                      ? t("terminal.you")
                      : activeThread.provider === "codex"
                        ? t("terminal.codex")
                        : t("terminal.claude")}
                  </strong>
                  <p>{message.text}</p>
                  {message.error && (
                    <span className="error">{message.error}</span>
                  )}
                </article>
              ))
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
