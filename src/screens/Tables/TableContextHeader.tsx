import { Icon } from "../../components/Icon";
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
    <div className="table-data-context">
      <div className="table-data-identity">
        <Icon name={table.kind === "view" ? "view" : "table"} />
        <strong>{tableLabel(connection.engine, table)}</strong>
        <span className="ds-context-badge">
          {table.kind === "view" ? t("schema.view") : t("tables.sourceTable")}
        </span>
      </div>
      <div className="ds-meta-row">
        <span>{t("tables.cols", { count: table.columns.length })}</span>
        <span className="ds-meta-dot" />
        <span>LIMIT {pageSize.toLocaleString()}</span>
        {result && (
          <>
            <span className="ds-meta-dot" />
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
            <span className="ds-meta-dot" />
            <span>{result.durationMs} ms</span>
          </>
        )}
      </div>
    </div>
  );
}
