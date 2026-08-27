// Identifier quoting + table labels, shared by the sidebar explorer and the data view.
import type { CatalogTable, Engine } from "../ipc/types";

export function quoteIdent(engine: Engine, name: string): string {
  if (engine === "mysql" || engine === "bigquery") {
    return "`" + name.replace(/`/g, "``") + "`";
  }
  return '"' + name.replace(/"/g, '""') + '"';
}

export function tableRef(engine: Engine, t: CatalogTable): string {
  const q = (n: string) => quoteIdent(engine, n);
  if (engine === "postgres" && t.schema) return `${q(t.schema)}.${q(t.name)}`;
  if (engine === "mysql" && t.database) {
    return `${q(t.database)}.${q(t.name)}`;
  }
  if (engine === "bigquery") {
    const namespace = t.schema ?? t.database;
    const path = namespace ? `${namespace}.${t.name}` : t.name;
    return "`" + path.replace(/`/g, "``") + "`";
  }
  return q(t.name);
}

export function tableLabel(engine: Engine, t: CatalogTable): string {
  return (engine === "postgres" && t.schema && t.schema !== "public")
    || (engine === "bigquery" && t.schema)
    ? `${t.schema}.${t.name}`
    : t.name;
}

export function tableKey(t: CatalogTable): string {
  return `${t.database ?? ""}.${t.schema ?? ""}.${t.name}`;
}
