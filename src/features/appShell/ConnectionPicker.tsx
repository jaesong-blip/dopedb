import { useMemo } from "react";

import EngineMark from "../../components/EngineMark";
import { Icon } from "../../components/Icon";
import type { ConnectionProfile } from "../connections/domain";
import { useI18n } from "../../lib/i18n";
import {
  buildConnectionSections,
  type SchemaConnectionGroup,
} from "../../lib/schemaDiff";

function connectionEndpoint(connection: ConnectionProfile) {
  if (connection.engine === "sqlite") {
    return connection.database || connection.host || "sqlite";
  }
  return `${connection.host}${connection.port ? `:${connection.port}` : ""}`;
}

export default function ConnectionPicker({
  connections,
  onSelect,
  onNew,
}: {
  connections: ConnectionProfile[];
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const { t } = useI18n();
  const sections = useMemo(() => buildConnectionSections(connections), [connections]);
  const grouped = sections.filter((section) => section.kind === "group");
  const singles = sections.filter((section) => section.kind === "single");

  function renderConnectionCard(connection: ConnectionProfile, grouped = false) {
    const name = connection.name || t("app.unnamed");
    return (
      <button
        key={connection.id}
        type="button"
        className="connection-card"
        onClick={() => onSelect(connection.id)}
        title={`${connection.engine} · ${connectionEndpoint(connection)} · ${connection.database}`}
        aria-label={t("app.openConnection", { name })}
      >
        <span className="connection-card-title">
          {!grouped && <EngineMark engine={connection.engine} />}
          <span className="connection-card-name">{name}</span>
          {connection.env && (
            <span className={`env-chip env-${connection.env}`}>{connection.env}</span>
          )}
        </span>
        <span className="connection-card-meta">
          <span>{connection.database || t("common.unknown")}</span>
          <span className="ds-meta-dot" />
          <span>{connectionEndpoint(connection)}</span>
        </span>
      </button>
    );
  }

  function renderGroup(group: SchemaConnectionGroup) {
    const engine = group.connections[0]?.engine;
    return (
      <section className="connection-group-section" key={group.key}>
        <div className="connection-group-head">
          <div className="connection-group-title">
            {engine ? (
              <EngineMark engine={engine} />
            ) : (
              <span className="connection-group-mark" />
            )}
            <span>{group.label}</span>
          </div>
        </div>
        <div className="connection-card-grid">
          {group.connections.map((connection) => renderConnectionCard(connection, true))}
        </div>
      </section>
    );
  }

  return (
    <div className="connection-picker">
      <div className="connection-picker-head">
        <h2>{t("app.connectionPickerTitle")}</h2>
        <button className="btn small" onClick={onNew}>
          <Icon name="plus" />
          {t("connections.new")}
        </button>
      </div>

      {grouped.length > 0 && (
        <section className="connection-picker-section">
          <div className="connection-picker-label">{t("app.connectionPickerGroups")}</div>
          {grouped.map((section) =>
            section.kind === "group" ? renderGroup(section.group) : null,
          )}
        </section>
      )}

      {singles.length > 0 && (
        <section className="connection-picker-section">
          <div className="connection-picker-label">{t("app.connectionPickerSingles")}</div>
          <div className="connection-card-grid">
            {singles.map((section) =>
              section.kind === "single"
                ? renderConnectionCard(section.connection)
                : null,
            )}
          </div>
        </section>
      )}
    </div>
  );
}
