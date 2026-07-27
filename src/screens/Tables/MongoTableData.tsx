import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import DataGrid from "../../components/DataGrid";
import { Icon } from "../../components/Icon";
import Skeleton from "../../components/Skeleton";
import type { ConnectionProfile } from "../../features/connections/domain";
import { useTablePageState } from "../../features/tableData/state";
import type { CatalogTable, QueryResult } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import { documentsToGrid } from "../../lib/documentGrid";
import { useI18n } from "../../lib/i18n";
import {
  documentCountQuery,
  documentRowsQuery,
} from "../../lib/queries";
import { tableKey, tableLabel } from "../../lib/tableRef";
import Pager from "./Pager";

const PAGE = 100;

export default function MongoTableData({
  connection,
  table,
}: {
  connection: ConnectionProfile;
  table: CatalogTable;
}) {
  const { t } = useI18n();
  const pageSize = PAGE;
  const key = tableKey(table);
  const [page, setPage] = useTablePageState(key);

  const rowsQuery = useQuery({
    ...documentRowsQuery({
      connectionId: connection.id,
      collection: table.name,
      pageSize,
      page,
    }),
    placeholderData: keepPreviousData,
  });
  const countQuery = useQuery(documentCountQuery(connection.id, table.name));
  const documentPage = rowsQuery.data ?? null;
  const total = countQuery.data ?? null;
  const busy = rowsQuery.isFetching;
  const error = rowsQuery.error ? errMessage(rowsQuery.error) : null;
  const fallbackColumns = useMemo(
    () => table.columns.map((column) => column.name),
    [table.columns],
  );
  const grid = useMemo(
    () => documentsToGrid(documentPage?.documents ?? [], fallbackColumns),
    [documentPage, fallbackColumns],
  );
  const result: QueryResult = {
    columns: grid.columns,
    rows: grid.rows,
    rowCount: grid.rows.length,
    truncated: documentPage?.truncated ?? false,
    durationMs: documentPage?.durationMs ?? 0,
  };
  const rows = result.rows.length;
  const from = rows === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + rows;

  return (
    <div className="table-data">
      <div className="table-data-context">
        <div className="table-data-identity">
          <Icon name={table.kind === "view" ? "view" : "collection"} />
          <strong>{tableLabel(connection.engine, table)}</strong>
          <span className="ds-context-badge">
            {table.kind === "view"
              ? t("schema.view")
              : t("tables.sourceCollection")}
          </span>
        </div>
        <div className="ds-meta-row">
          <span>LIMIT {pageSize.toLocaleString()}</span>
          {documentPage && (
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
                {documentPage.truncated ? " (truncated)" : ""}
              </span>
              <span className="ds-meta-dot" />
              <span>{documentPage.durationMs} ms</span>
            </>
          )}
        </div>
      </div>
      <div className="grid-toolbar ds-data-toolbar ds-control-row">
        <span className="ds-toolbar-spacer" />
        <Pager
          page={page}
          pageSize={pageSize}
          total={total}
          rows={rows}
          busy={busy}
          onPage={setPage}
          onRefresh={() => {
            void rowsQuery.refetch();
            void countQuery.refetch();
          }}
        />
      </div>

      {error && <div className="error">{error}</div>}
      <div
        className={
          busy && documentPage ? "table-data-body busy" : "table-data-body"
        }
      >
        {documentPage ? (
          <>
            <DataGrid
              result={result}
              startIndex={page * pageSize}
              columnMeta={Object.fromEntries(
                table.columns.map((column) => [
                  column.name,
                  { dataType: column.dataType, pk: column.pk },
                ]),
              )}
            />
            {rows === 0 && !busy && (
              <div className="muted">{t("tables.tableEmpty")}</div>
            )}
          </>
        ) : (
          !error &&
          (busy ? (
            <Skeleton lines={8} />
          ) : (
            <div className="muted">{t("tables.noRows")}</div>
          ))
        )}
      </div>
    </div>
  );
}
