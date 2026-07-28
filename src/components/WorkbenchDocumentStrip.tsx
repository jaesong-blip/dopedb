import { useState } from "react";

import type { ConnectionProfile } from "../features/connections/domain";
import type { WorkbenchDocument } from "../features/workbench/domain";
import { tableLabel } from "../lib/tableRef";
import { useI18n } from "../lib/i18n";
import { Icon } from "./Icon";

export default function WorkbenchDocumentStrip({
  documents,
  activeId,
  engine,
  connectionName,
  supportsSql,
  onActivate,
  onRename,
  onClose,
  onNewQuery,
  onOpenActivity,
}: {
  documents: WorkbenchDocument[];
  activeId: string | null;
  engine: ConnectionProfile["engine"];
  connectionName: string;
  supportsSql: boolean;
  onActivate: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onClose: (id: string) => void;
  onNewQuery: () => void;
  onOpenActivity: () => void;
}) {
  const { t } = useI18n();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const visibleDocuments = documents.filter((document) => document.kind !== "schema");
  const hasVisibleActiveDocument = visibleDocuments.some(
    (document) => document.id === activeId,
  );
  const keyboardFallbackId = visibleDocuments[0]?.id ?? null;

  function label(document: WorkbenchDocument, index: number) {
    if (document.kind === "data") return tableLabel(engine, document.table);
    if (document.kind === "schema") return t("tabs.schema");
    if (document.kind === "activity") return t("tabs.activity");
    if (document.kind === "documents") return `${t("tabs.documents")} ${index + 1}`;
    if (document.kind === "sql") {
      const title = document.title || `${t("tabs.sql")} ${index + 1}`;
      return `${title} [${connectionName}]`;
    }
    return t("tabs.schema");
  }

  let queryIndex = 0;
  function finishRename(id: string) {
    const title = renameValue.trim();
    if (title) onRename(id, title);
    setRenamingId(null);
  }

  return (
    <div className="workbench-document-strip tw:flex tw:min-h-control-lg tw:min-w-0 tw:items-stretch tw:border-b tw:border-border-subtle tw:bg-muted">
      <div
        className="workbench-document-tabs ds-control-row tw:flex tw:min-w-0 tw:flex-1 tw:items-stretch tw:overflow-x-auto tw:[scrollbar-width:thin]"
        role="tablist"
        aria-label={t("app.workbenchNavigation")}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const tabs = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
          ];
          const current = tabs.indexOf(event.target as HTMLButtonElement);
          if (current < 0) return;
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          tabs[(current + direction + tabs.length) % tabs.length]?.focus();
        }}
      >
        {visibleDocuments.map((document) => {
          const index =
            document.kind === "sql" || document.kind === "documents" ? queryIndex++ : 0;
          const title = label(document, index);
          const active = activeId === document.id;
          const renaming =
            document.kind === "sql" && renamingId === document.id;
          return (
            <div
              data-active={active}
              className="workbench-document-tab tw:flex tw:min-w-0 tw:max-w-[220px] tw:flex-[0_1_180px] tw:items-center tw:border-r tw:border-border-subtle tw:text-muted-foreground tw:data-[active=true]:bg-secondary tw:data-[active=true]:text-selection-foreground tw:data-[active=true]:shadow-[inset_0_calc(var(--ds-border-width-strong)*-1)_0_var(--ds-selection-foreground)] tw:max-[760px]:basis-[148px]"
              key={document.id}
            >
              {renaming ? (
                <input
                  autoFocus
                  className="tw:m-1 tw:min-w-0 tw:flex-1 tw:border-border-strong tw:bg-background tw:px-1 tw:text-sm tw:text-foreground"
                  value={renameValue}
                  aria-label={t("sql.documentTitle")}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => finishRename(document.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      finishRename(document.id);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingId(null);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="workbench-document-select tw:flex tw:min-h-control-lg tw:min-w-0 tw:flex-1 tw:cursor-pointer tw:items-center tw:gap-2 tw:border-0 tw:bg-transparent tw:px-2 tw:font-sans tw:text-inherit tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-inset tw:focus-visible:ring-ring tw:[&_.icon]:shrink-0 tw:[&>span]:min-w-0 tw:[&>span]:overflow-hidden tw:[&>span]:text-ellipsis tw:[&>span]:whitespace-nowrap"
                  role="tab"
                  aria-selected={active}
                  tabIndex={
                    active || (!hasVisibleActiveDocument && document.id === keyboardFallbackId)
                      ? 0
                      : -1
                  }
                  onClick={() => onActivate(document.id)}
                  onDoubleClick={() => {
                    if (document.kind !== "sql") return;
                    setRenameValue(document.title);
                    setRenamingId(document.id);
                  }}
                  title={title}
                >
                  <Icon
                    name={
                      document.kind === "data"
                        ? "table"
                        : document.kind === "schema"
                          ? "dashboard"
                          : document.kind === "activity"
                            ? "chart"
                            : document.kind === "documents"
                              ? "list"
                              : "play"
                    }
                  />
                  <span>{title}</span>
                </button>
              )}
              <button
                type="button"
                className="btn small icon-only icon-xs tw:mr-1"
                onClick={() => onClose(document.id)}
                title={t("common.close")}
                aria-label={`${t("common.close")}: ${title}`}
              >
                <Icon name="close" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="ds-control-row tw:flex tw:shrink-0 tw:items-center tw:border-l tw:border-border-subtle tw:px-2 tw:max-[760px]:px-1">
        <button
          type="button"
          className="btn small icon-only"
          onClick={onOpenActivity}
          title={t("tabs.activity")}
          aria-label={t("tabs.activity")}
        >
          <Icon name="chart" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          onClick={onNewQuery}
          title={supportsSql ? t("tabs.sql") : t("tabs.documents")}
          aria-label={supportsSql ? t("tabs.sql") : t("tabs.documents")}
        >
          <Icon name="plus" />
        </button>
      </div>
    </div>
  );
}
