import type { ConnectionProfile } from "../../features/connections/domain";
import type { CatalogTable, SafetySettings } from "../../ipc/types";
import { isDocumentEngine } from "../../lib/capabilities";
import MongoTableData from "./MongoTableData";
import SqlTableData from "./SqlTableData";

export default function TableData({
  connection,
  table,
  safety,
}: {
  connection: ConnectionProfile;
  table: CatalogTable;
  safety: SafetySettings;
}) {
  if (isDocumentEngine(connection.engine)) {
    return <MongoTableData connection={connection} table={table} />;
  }
  const sqlTableKey = [table.database, table.schema, table.name, table.kind]
    .filter(Boolean)
    .join(".");
  return (
    <SqlTableData
      key={sqlTableKey}
      connection={connection}
      table={table}
      safety={safety}
    />
  );
}
