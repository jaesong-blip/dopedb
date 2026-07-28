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
    <section
      className="tw:flex tw:min-h-0 tw:flex-col tw:gap-4 tw:p-4"
      aria-labelledby="retired-archive-title"
    >
      <div className="tw:inline-flex tw:items-center tw:gap-2">
        <Icon name="history" />
        <div className="tw:min-w-0">
          <h2 id="retired-archive-title" className="tw:m-0">
            {t("settings.retiredArchive")}
          </h2>
          <p className="tw:m-0 tw:text-muted-foreground">
            {t("settings.retiredArchiveDescription")}
          </p>
        </div>
      </div>
      {!connection ? (
        <p className="tw:text-muted-foreground">{t("settings.selectConnection")}</p>
      ) : (
        <div className="tw:grid tw:min-h-[360px] tw:min-w-0 tw:grid-cols-[minmax(180px,280px)_minmax(0,1fr)] tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle tw:@max-[700px]:grid-cols-1 tw:@max-[700px]:grid-rows-[minmax(132px,34dvh)_minmax(0,1fr)]">
          <nav
            aria-label={t("settings.retiredArchive")}
            className="tw:flex tw:min-h-0 tw:min-w-0 tw:flex-col tw:gap-2 tw:overflow-auto tw:border-r tw:border-border-subtle tw:bg-muted tw:p-3 tw:@max-[700px]:border-r-0 tw:@max-[700px]:border-b"
          >
            {threadsQuery.isPending ? (
              <span className="tw:text-muted-foreground">{t("common.loading")}</span>
            ) : threadsQuery.error ? (
              <span className="tw:text-ui tw:text-danger" role="alert">
                {t("terminal.archiveLoadFailed", {
                  error: errMessage(threadsQuery.error),
                })}
              </span>
            ) : threads.length === 0 ? (
              <span className="tw:text-muted-foreground">
                {t("terminal.archiveEmpty")}
              </span>
            ) : (
              threads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className="tw:grid tw:min-h-control-xl tw:cursor-pointer tw:gap-1 tw:rounded-sm tw:border-0 tw:bg-transparent tw:p-2 tw:font-sans tw:text-left tw:text-foreground tw:aria-pressed:bg-selection tw:aria-pressed:text-selection-foreground tw:hover:bg-selection tw:[&>strong]:overflow-hidden tw:[&>strong]:text-ellipsis tw:[&>strong]:whitespace-nowrap tw:[&>span]:overflow-hidden tw:[&>span]:text-xs tw:[&>span]:text-muted-foreground tw:[&>span]:text-ellipsis tw:[&>span]:whitespace-nowrap"
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
            className="tw:flex tw:min-h-0 tw:min-w-0 tw:flex-col tw:gap-2 tw:overflow-auto tw:p-3"
            aria-live="polite"
            aria-label={activeThread?.title ?? t("settings.retiredArchive")}
          >
            {!activeThread ? null : messagesQuery.isPending ? (
              <span className="tw:text-muted-foreground">{t("common.loading")}</span>
            ) : messagesQuery.error ? (
              <span className="tw:text-ui tw:text-danger" role="alert">
                {t("terminal.archiveLoadFailed", {
                  error: errMessage(messagesQuery.error),
                })}
              </span>
            ) : (messagesQuery.data ?? []).length === 0 ? (
              <span className="tw:text-muted-foreground">
                {t("terminal.archiveNoMessages")}
              </span>
            ) : (
              (messagesQuery.data ?? []).map((message) => (
                <article
                  key={message.id}
                  data-role={message.role}
                  className="tw:grid tw:max-w-[min(76ch,92%)] tw:gap-1 tw:data-[role=user]:self-end tw:data-[role=user]:rounded-md tw:data-[role=user]:bg-secondary tw:data-[role=user]:p-3"
                >
                  <strong className="tw:text-xs tw:text-muted-foreground">
                    {message.role === "user"
                      ? t("terminal.you")
                      : activeThread.provider === "codex"
                        ? t("terminal.codex")
                        : t("terminal.claude")}
                  </strong>
                  <p className="tw:m-0 tw:leading-relaxed tw:whitespace-pre-wrap tw:break-words">
                    {message.text}
                  </p>
                  {message.error && (
                    <span className="tw:text-ui tw:text-danger">
                      {message.error}
                    </span>
                  )}
                </article>
              ))
            )}
          </section>
        </div>
      )}
    </section>
  );
}
