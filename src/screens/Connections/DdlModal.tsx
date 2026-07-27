import { useEffect, useRef } from "react";

import LazySqlViewer from "../../components/LazySqlViewer";
import { useTableDdl } from "../../features/catalog/useTableDdl";
import type { ConnectionProfile } from "../../features/connections/domain";
import type { CatalogTable } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import { tableLabel } from "../../lib/tableRef";

export default function DdlModal({
  connection,
  table,
  onClose,
}: {
  connection: ConnectionProfile;
  table: CatalogTable;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { text, error, copied, copy } = useTableDdl(
    connection.id,
    table.name,
    table.schema,
  );
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => trigger?.focus?.();
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) =>
      event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="ddl-overlay" onClick={onClose}>
      <div
        className="ddl-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ddl-head">
          <span className="ddl-title">
            {t("connections.ddlTitle", {
              table: tableLabel(connection.engine, table),
            })}
          </span>
          <div className="ddl-actions ds-control-row">
            <button
              className="btn small"
              onClick={() => void copy()}
              disabled={!text}
            >
              {copied ? t("common.copied") : t("common.copy")}
            </button>
            <button
              className="btn small"
              ref={closeRef}
              onClick={onClose}
            >
              {t("common.close")}
            </button>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        {!error && text == null && (
          <div className="muted small-pad loading">{t("common.loading")}</div>
        )}
        {text != null && <LazySqlViewer value={text} minHeight="240px" />}
      </div>
    </div>
  );
}
