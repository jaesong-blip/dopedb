import { useEffect, useRef } from "react";

import LazySqlViewer from "../../components/LazySqlViewer";
import {
  ModalBackdrop,
  ModalFooter,
  ModalSurface,
  ModalTitleBar,
} from "../../design-system/components/Modal";
import { LoadingLabel } from "../../design-system/components/Status";
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
    <ModalBackdrop onMouseDown={onClose}>
      <ModalSurface
        aria-labelledby="ddl-dialog-title"
        aria-busy={text == null && !error}
      >
        <ModalTitleBar
          title={t("connections.ddlTitle", {
            table: tableLabel(connection.engine, table),
          })}
          titleId="ddl-dialog-title"
          closeLabel={t("common.close")}
          onClose={onClose}
        />
        <div className="tw:min-h-[280px] tw:min-w-0 tw:flex-1 tw:overflow-auto tw:bg-background tw:p-3">
          {error ? (
            <div className="tw:text-ui tw:text-danger" role="alert">
              {error}
            </div>
          ) : null}
          {!error && text == null && (
            <div className="tw:px-2 tw:py-1">
              <LoadingLabel>{t("common.loading")}</LoadingLabel>
            </div>
          )}
          {text != null && <LazySqlViewer value={text} minHeight="240px" />}
        </div>
        <ModalFooter>
          <button
            className="btn"
            onClick={() => void copy()}
            disabled={!text}
          >
            {copied ? t("common.copied") : t("common.copy")}
          </button>
          <button className="btn" ref={closeRef} onClick={onClose}>
            {t("common.close")}
          </button>
        </ModalFooter>
      </ModalSurface>
    </ModalBackdrop>
  );
}
