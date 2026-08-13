import { invoke } from "../../ipc/core";
import type {
  Catalog,
  CatalogOverview,
  CatalogSnapshot,
  DatabaseSummary,
} from "../../ipc/types";

async function getSchema(id: string): Promise<string> {
  return invoke("get_schema", { id });
}

export async function getCatalog(id: string): Promise<Catalog> {
  return JSON.parse(await getSchema(id)) as Catalog;
}

export async function refreshCatalog(id: string): Promise<Catalog> {
  return JSON.parse(await invoke<string>("refresh_schema", { id })) as Catalog;
}

export function getCatalogSnapshot(id: string): Promise<CatalogSnapshot> {
  return invoke("get_catalog_snapshot", { id });
}

export function getCatalogOverview(id: string): Promise<CatalogOverview> {
  return invoke("get_catalog_overview", { id });
}

export function listConnectionDatabases(id: string): Promise<DatabaseSummary[]> {
  return invoke("list_connection_databases", { id });
}

export async function getDatabaseCatalog(
  id: string,
  database: string,
): Promise<Catalog> {
  return JSON.parse(
    await invoke<string>("get_database_schema", { id, database }),
  ) as Catalog;
}

export function getDatabaseCatalogOverview(
  id: string,
  database: string,
): Promise<CatalogOverview> {
  return invoke("get_database_catalog_overview", { id, database });
}

export function getDatabaseCatalogSnapshot(
  id: string,
  database: string,
): Promise<CatalogSnapshot> {
  return invoke("get_database_catalog_snapshot", { id, database });
}

export function getTableDdl(
  connectionId: string,
  table: string,
  schema?: string | null,
  database?: string | null,
): Promise<string> {
  if (database) {
    return invoke("get_database_table_ddl", {
      id: connectionId,
      database,
      schema: schema ?? null,
      table,
    });
  }
  return invoke("get_table_ddl", {
    id: connectionId,
    schema: schema ?? null,
    table,
  });
}
