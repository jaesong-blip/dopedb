import {
  MetadataDot,
  WorkbenchContextHeader,
} from "../../design-system/components/Workbench";
import type { ConnectionProfile } from "../../features/connections/domain";
import type { CatalogTable } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import { tableLabel } from "../../lib/tableRef";

export default function TableContextHeader({
  connection,
  table,
  pageSize,
}: {
  connection: ConnectionProfile;
  table: CatalogTable;
  pageSize: number;
}) {
  const { t } = useI18n();
  return (
    <WorkbenchContextHeader
      icon={table.kind === "view" ? "view" : "table"}
      title={tableLabel(connection.engine, table)}
      badge={
        table.kind === "view" ? t("schema.view") : t("tables.sourceTable")
      }
      metadata={
        <>
        <span>{t("tables.cols", { count: table.columns.length })}</span>
        <MetadataDot />
        <span>LIMIT {pageSize.toLocaleString()}</span>
        </>
      }
    />
  );
}
