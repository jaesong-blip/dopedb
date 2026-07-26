// Read-only migration surface for conversations created before Terminal sessions.
// It intentionally lives in Settings: the PTY chrome owns no historical chat UI.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ConnectionProfile } from "../../features/connections/domain";
import type { RetiredChatThreadId } from "../../features/agents/domain";
import {
  retiredChatArchiveMessagesQuery,
  retiredChatArchiveThreadsQuery,
} from "../../features/agents/queryOptions";
import { errMessage } from "../../ipc/types";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../lib/i18n";

export default function RetiredChatArchive({
  connection,
}: {
  connection: ConnectionProfile | null;
}) {
  const { lang, t } = useI18n();
  const threadsQuery = useQuery(retiredChatArchiveThreadsQuery());
  const threads = useMemo(
    () =>
      connection
        ? (threadsQuery.data ?? []).filter(
            (thread) => thread.connectionId === connection.id,
          )
        : [],
    [connection, threadsQuery.data],
  );
  const [activeId, setActiveId] = useState<RetiredChatThreadId | null>(null);
  const activeThread =
    threads.find((thread) => thread.id === activeId) ?? threads[0] ?? null;
  const messagesQuery = useQuery(
    retiredChatArchiveMessagesQuery(activeThread?.id ?? null),
  );
  const date = useMemo(
    () =>
      new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [lang],
  );

  return (
    <section className="screen retired-archive" aria-labelledby="retired-archive-title">
      <div className="settings-title-row">
        <Icon name="history" />
        <div>
          <h2 id="retired-archive-title">{t("settings.retiredArchive")}</h2>
          <p className="muted">{t("settings.retiredArchiveDescription")}</p>
        </div>
      </div>
      {!connection ? (
        <p className="muted">{t("settings.selectConnection")}</p>
      ) : (
        <div className="retired-archive-layout">
          <nav aria-label={t("settings.retiredArchive")} className="retired-archive-list">
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
                  className="retired-archive-thread"
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
            className="retired-archive-messages"
            aria-live="polite"
            aria-label={activeThread?.title ?? t("settings.retiredArchive")}
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
                <article key={message.id} className={`retired-archive-message ${message.role}`}>
                  <strong>
                    {message.role === "user"
                      ? t("terminal.you")
                      : activeThread.provider === "codex"
                        ? t("terminal.codex")
                        : t("terminal.claude")}
                  </strong>
                  <p>{message.text}</p>
                  {message.error && <span className="error">{message.error}</span>}
                </article>
              ))
            )}
          </section>
        </div>
      )}
    </section>
  );
}
