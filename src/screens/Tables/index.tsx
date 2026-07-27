import type { ConnectionProfile } from "../../features/connections/domain";
import type { CatalogTable, SafetySettings } from "../../ipc/types";
import { isDocumentEngine } from "../../lib/capabilities";
import MongoTableData from "./MongoTableData";
import SqlTableData from "./SqlTableData";
import "./tables.css";

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
  return <SqlTableData connection={connection} table={table} safety={safety} />;
}
