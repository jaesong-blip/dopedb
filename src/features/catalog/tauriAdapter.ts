import { invoke } from "../../ipc/core";

export function getTableDdl(
  connectionId: string,
  table: string,
  schema?: string | null,
  database?: string | null,
): Promise<string> {
  return invoke(
    database ? "get_database_table_ddl" : "get_table_ddl",
    {
    id: connectionId,
    ...(database ? { database } : {}),
    schema: schema ?? null,
    table,
    },
  );
}
