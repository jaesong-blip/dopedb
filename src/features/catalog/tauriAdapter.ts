import { invoke } from "@tauri-apps/api/core";

export function getTableDdl(
  connectionId: string,
  table: string,
  schema?: string | null,
): Promise<string> {
  return invoke("get_table_ddl", {
    id: connectionId,
    schema: schema ?? null,
    table,
  });
}
