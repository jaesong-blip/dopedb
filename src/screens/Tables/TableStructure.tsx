import type { CatalogTable } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";

export default function TableStructure({ table }: { table: CatalogTable }) {
  const { t } = useI18n();
  return (
    <div className="table-structure">
      <table className="struct-table">
        <thead>
          <tr>
            <th>{t("tables.column")}</th>
            <th>{t("tables.type")}</th>
            <th>{t("tables.nullable")}</th>
            <th>PK</th>
          </tr>
        </thead>
        <tbody>
          {table.columns.map((column) => (
            <tr key={column.name}>
              <td>{column.name}</td>
              <td className="muted">{column.dataType}</td>
              <td>{column.nullable ? t("common.yes") : t("common.no")}</td>
              <td>{column.pk ? "PK" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="struct-meta">
        <div>
          <strong>{t("tables.indexes")}</strong>
          {table.indexes.length ? (
            <ul>
              {table.indexes.map((index) => (
                <li key={index.name}>
                  {index.name}
                  {index.unique ? ` (${t("tables.unique")})` : ""}:{" "}
                  {index.columns.join(", ")}
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted"> {t("common.none")}</span>
          )}
        </div>
        <div>
          <strong>{t("tables.foreignKeys")}</strong>
          {table.foreignKeys.length ? (
            <ul>
              {table.foreignKeys.map((foreignKey) => (
                <li
                  key={`${foreignKey.column}-${foreignKey.referencesTable}-${foreignKey.referencesColumn}`}
                >
                  {foreignKey.column} →{" "}
                  {foreignKey.referencesSchema
                    ? `${foreignKey.referencesSchema}.`
                    : ""}
                  {foreignKey.referencesTable}.{foreignKey.referencesColumn}
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted"> {t("common.none")}</span>
          )}
        </div>
      </div>
    </div>
  );
}
