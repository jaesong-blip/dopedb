import { useEffect, useMemo, useState } from "react";

import { Icon } from "../../components/Icon";
import { Button } from "../../design-system/components/Button";
import { LoadingLabel } from "../../design-system/components/Status";
import {
  ToolWindowHeader,
  ToolWindowHideButton,
  ToolWindowSearchRow,
  ToolWindowSideSurface,
  ToolWindowVerticalSplit,
} from "../../design-system/components/ToolWindow";
import { TreeSearch } from "../../design-system/components/TreeControls";
import type { ConnectionProfile } from "../connections/domain";
import { connectionId, sqlDocumentId } from "../sqlDocuments/domain";
import type { SqlDocumentRevision } from "../sqlDocuments/domain";
import { tauriSqlDocumentGateway } from "../sqlDocuments/tauriAdapter";
import type { WorkbenchDocument } from "../workbench/domain";
import { errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";

type SqlWorkbenchDocument = Extract<WorkbenchDocument, { kind: "sql" }>;

export default function LocalHistoryToolWindow({
  connection,
  documents,
  activeDocumentId,
  onActivateDocument,
  onRestoreRevision,
  onClose,
  compact = false,
  compactOpen = false,
}: {
  connection: ConnectionProfile | null;
  documents: WorkbenchDocument[];
  activeDocumentId: string | null;
  onActivateDocument: (id: string) => void;
  onRestoreRevision: (id: string, content: string) => void;
  onClose: () => void;
  compact?: boolean;
  compactOpen?: boolean;
}) {
  const { t } = useI18n();
  const sqlDocuments = useMemo(
    () =>
      documents.filter(
        (document): document is SqlWorkbenchDocument =>
          document.kind === "sql" && document.persistedId !== null,
      ),
    [documents],
  );
  const activeSqlDocument = sqlDocuments.find(
    (document) => document.id === activeDocumentId,
  );
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(
    activeSqlDocument?.id ?? sqlDocuments[0]?.id ?? null,
  );
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [revisions, setRevisions] = useState<SqlDocumentRevision[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const selectedDocument =
    sqlDocuments.find((document) => document.id === selectedDocumentId) ??
    activeSqlDocument ??
    sqlDocuments[0] ??
    null;

  useEffect(() => {
    if (activeSqlDocument) setSelectedDocumentId(activeSqlDocument.id);
  }, [activeSqlDocument?.id]);

  useEffect(() => {
    let stale = false;
    setSelectedRevision(null);
    if (!connection || !selectedDocument?.persistedId) {
      setRevisions([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    void tauriSqlDocumentGateway
      .listRevisions(
        connectionId(connection.id),
        sqlDocumentId(selectedDocument.persistedId),
      )
      .then((next) => {
        if (stale) return;
        setRevisions(next);
        setSelectedRevision(next[0]?.localRevision ?? null);
      })
      .catch((reason) => {
        if (!stale) {
          setRevisions([]);
          setError(errMessage(reason));
        }
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [
    connection?.id,
    selectedDocument?.persistedId,
    selectedDocument?.revision,
  ]);

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const filteredDocuments = sqlDocuments.filter((document) =>
    document.title.toLocaleLowerCase().includes(normalizedFilter),
  );
  const filteredRevisions = revisions.filter((revision) => {
    if (!normalizedFilter) return true;
    return [
      revision.localRevision.toString(),
      revision.createdAt,
      revision.content,
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedFilter);
  });
  const activeRevision =
    revisions.find(
      (revision) => revision.localRevision === selectedRevision,
    ) ?? null;
  const canRestore =
    !!selectedDocument &&
    !!activeRevision &&
    activeRevision.content !== selectedDocument.draft;

  function selectDocument(document: SqlWorkbenchDocument) {
    setSelectedDocumentId(document.id);
    onActivateDocument(document.id);
  }

  return (
    <ToolWindowSideSurface
      compact={compact}
      compactOpen={compactOpen}
    >
      <ToolWindowHeader
        title={
          <span className="tw:flex tw:min-w-0 tw:items-center tw:gap-6">
            <span className="tw:truncate">{t("localHistory.title")}</span>
            <span className="tw:truncate tw:font-medium tw:text-muted-foreground">
              {t("localHistory.recent")}
            </span>
          </span>
        }
        actions={
          <ToolWindowHideButton
            label={t("common.close")}
            onClick={onClose}
          />
        }
      />
      <ToolWindowSearchRow>
        <div className="tw:min-w-0 tw:flex-1">
          <TreeSearch
            clearLabel={t("common.close")}
            placeholder={t("localHistory.search")}
            value={filter}
            onChange={setFilter}
          />
        </div>
        <Button
          iconOnly
          size="xs"
          variant="ghost"
          disabled={!canRestore}
          onClick={() => {
            if (!selectedDocument || !activeRevision) return;
            onRestoreRevision(
              selectedDocument.id,
              activeRevision.content,
            );
          }}
          title={t("localHistory.restore")}
          aria-label={t("localHistory.restore")}
        >
          <Icon name="history" />
        </Button>
      </ToolWindowSearchRow>
      <ToolWindowVerticalSplit>
        <section className="tw:flex tw:flex-col">
          <div className="tw:min-h-0 tw:flex-1 tw:overflow-auto tw:p-1">
            {loading ? (
              <div className="tw:p-2 tw:text-sm">
                <LoadingLabel>{t("common.loading")}</LoadingLabel>
              </div>
            ) : error ? (
              <div
                className="tw:p-2 tw:text-sm tw:text-danger"
                role="alert"
              >
                {t("localHistory.loadFailed", { error })}
              </div>
            ) : !selectedDocument ? (
              <p className="tw:m-0 tw:p-2 tw:text-sm tw:text-muted-foreground">
                {t("localHistory.noDocument")}
              </p>
            ) : filteredRevisions.length === 0 ? (
              <p className="tw:m-0 tw:p-2 tw:text-sm tw:text-muted-foreground">
                {t("localHistory.empty")}
              </p>
            ) : (
              filteredRevisions.map((revision) => {
                const current =
                  revision.localRevision === selectedDocument.revision;
                return (
                  <button
                    key={revision.localRevision}
                    type="button"
                    data-active={revision.localRevision === selectedRevision}
                    className="tw:grid tw:min-h-11 tw:w-full tw:min-w-0 tw:cursor-pointer tw:items-center tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-2 tw:py-1 tw:font-sans tw:text-left tw:text-foreground tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:hover:bg-muted"
                    onClick={() =>
                      setSelectedRevision(revision.localRevision)
                    }
                    title={revision.content}
                  >
                    <span className="tw:grid tw:min-w-0 tw:gap-px">
                      <strong className="tw:overflow-hidden tw:text-sm tw:font-medium tw:text-ellipsis tw:whitespace-nowrap">
                        {t("localHistory.revision", {
                          revision: revision.localRevision,
                        })}
                        {current
                          ? ` · ${t("localHistory.current")}`
                          : ""}
                      </strong>
                      <small className="tw:overflow-hidden tw:text-2xs tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
                        {formatRevisionTime(revision.createdAt)}
                      </small>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </section>
        <section className="tw:flex tw:flex-col">
          <h2 className="tw:m-0 tw:px-2 tw:py-1 tw:text-xs tw:font-semibold tw:text-muted-foreground">
            {t("localHistory.files")}
          </h2>
          <div className="tw:min-h-0 tw:flex-1 tw:overflow-auto tw:p-1">
            {filteredDocuments.map((document) => (
              <button
                key={document.id}
                type="button"
                data-active={document.id === selectedDocument?.id}
                className="ds-object-row tw:w-full tw:min-w-0 tw:cursor-pointer tw:gap-1 tw:rounded-xs tw:border-0 tw:bg-transparent tw:font-sans tw:text-left tw:text-ui tw:data-[active=true]:bg-secondary tw:data-[active=true]:text-secondary-foreground tw:hover:bg-muted"
                onClick={() => selectDocument(document)}
              >
                <Icon
                  name="file"
                  className="tw:shrink-0 tw:text-[length:var(--ds-icon-sm)] tw:text-muted-foreground"
                />
                <span className="tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
                  {document.title}
                </span>
                <span className="tw:text-2xs tw:text-muted-foreground">
                  r{document.revision}
                </span>
              </button>
            ))}
          </div>
        </section>
      </ToolWindowVerticalSplit>
    </ToolWindowSideSurface>
  );
}

function formatRevisionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
