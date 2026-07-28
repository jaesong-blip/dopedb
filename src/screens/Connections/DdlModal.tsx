import { useEffect, useRef } from "react";

import LazySqlViewer from "../../components/LazySqlViewer";
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
    <div
      className="tw:fixed tw:inset-0 tw:z-[var(--ds-z-modal)] tw:flex tw:items-center tw:justify-center tw:bg-overlay tw:p-3 tw:max-[760px]:items-stretch"
      onClick={onClose}
    >
      <div
        className="tw:max-h-[76vh] tw:w-[min(640px,88vw)] tw:overflow-auto tw:rounded-lg tw:border tw:border-border-subtle tw:bg-popover tw:p-4 tw:text-popover-foreground tw:shadow-popover tw:max-[760px]:max-h-none tw:max-[760px]:w-full"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tw:mb-3 tw:flex tw:items-center tw:justify-between tw:gap-3 tw:max-[760px]:flex-col tw:max-[760px]:items-start">
          <span className="tw:font-mono tw:text-ui tw:font-semibold">
            {t("connections.ddlTitle", {
              table: tableLabel(connection.engine, table),
            })}
          </span>
          <div className="ds-control-row tw:flex tw:gap-2 tw:max-[760px]:w-full tw:max-[760px]:flex-wrap">
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
        {error ? (
          <div className="tw:text-ui tw:text-danger">{error}</div>
        ) : null}
        {!error && text == null && (
          <div className="tw:px-2 tw:py-1">
            <LoadingLabel>{t("common.loading")}</LoadingLabel>
          </div>
        )}
        {text != null && <LazySqlViewer value={text} minHeight="240px" />}
      </div>
    </div>
  );
}
