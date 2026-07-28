import {
  MetadataDot,
  WorkbenchContextHeader,
} from "../../design-system/components/Workbench";
import type { ConnectionProfile } from "../../features/connections/domain";
import type { CatalogTable, QueryResult } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import { tableLabel } from "../../lib/tableRef";

export default function TableContextHeader({
  connection,
  table,
  pageSize,
  result,
  total,
  from,
  to,
}: {
  connection: ConnectionProfile;
  table: CatalogTable;
  pageSize: number;
  result: QueryResult | null;
  total: number | null;
  from: number;
  to: number;
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
        {result && (
          <>
            <MetadataDot />
            <span>
              {total != null
                ? t("tables.rowRangeTotal", {
                    from,
                    to,
                    total: total.toLocaleString(),
                  })
                : t("tables.rowRange", { from, to })}
              {result.truncated ? " (truncated)" : ""}
            </span>
            <MetadataDot />
            <span>{result.durationMs} ms</span>
          </>
        )}
        </>
      }
    />
  );
}
