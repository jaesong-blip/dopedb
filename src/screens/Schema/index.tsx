// Catalog V2 schema explorer. React Flow/ELK owns the relationship canvas while the
// inspector and structured editor consume the same fingerprint-pinned metadata.
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CatalogRelationV2,
  CatalogTable,
  SafetySettings,
} from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import { Icon } from "../../components/Icon";
import InfoTip from "../../components/InfoTip";
import Skeleton from "../../components/Skeleton";
import { catalogQuery, catalogSnapshotQuery } from "../../lib/queries";
import {
  erdRelationKey,
  relationDisplayName,
} from "../../lib/erdGraph";
import { useI18n } from "../../lib/i18n";
import SchemaEditor from "./SchemaEditor";
import "./schema.css";

const ErdCanvas = lazy(() => import("../../components/ErdCanvas"));

function legacyTableFor(
  tables: CatalogTable[],
  relation: CatalogRelationV2,
) {
  return (
    tables.find(
      (table) =>
        table.schema === relation.object.namespace &&
        table.name === relation.object.name,
    ) ?? null
  );
}

export default function SchemaExplorer({
  connection,
  selectedTable,
  safety,
  onOpenTable,
}: {
  connection: ConnectionProfile;
  selectedTable: CatalogTable | null;
  safety: SafetySettings;
  onOpenTable: (table: CatalogTable) => void;
}) {
  const { t } = useI18n();
  const catalogQueryResult = useQuery(catalogQuery(connection.id));
  const snapshotQuery = useQuery(catalogSnapshotQuery(connection.id));
  const snapshot = snapshotQuery.data;
  const [filter, setFilter] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const preferred = selectedTable
      ? snapshot.relations.find(
          (relation) =>
            relation.object.namespace === selectedTable.schema &&
            relation.object.name === selectedTable.name,
        )
      : null;
    setSelectedKey((current) => {
      if (preferred) return erdRelationKey(preferred.object);
      if (
        current &&
        snapshot.relations.some(
          (relation) => erdRelationKey(relation.object) === current,
        )
      ) {
        return current;
      }
      return snapshot.relations[0]
        ? erdRelationKey(snapshot.relations[0].object)
        : null;
    });
  }, [selectedTable, snapshot]);

  const selected = useMemo(
    () =>
      snapshot?.relations.find(
        (relation) => erdRelationKey(relation.object) === selectedKey,
      ) ?? null,
    [selectedKey, snapshot],
  );
  const physicalRelationshipCount =
    snapshot?.relations.reduce(
      (count, relation) =>
        count +
        relation.constraints.filter(
          (constraint) => constraint.kind === "foreign",
        ).length,
      0,
    ) ?? 0;

  function openRelation(relation: CatalogRelationV2) {
    const table = legacyTableFor(
      catalogQueryResult.data?.tables ?? [],
      relation,
    );
    if (table) onOpenTable(table);
  }

  const error = snapshotQuery.error ?? catalogQueryResult.error;
  if (error) {
    return (
      <div className="screen schema-screen">
        <div className="error">{errMessage(error)}</div>
      </div>
    );
  }
  if (!snapshot || !catalogQueryResult.data) {
    return (
      <div className="screen schema-screen">
        <Skeleton lines={8} />
      </div>
    );
  }

  return (
    <div className="screen schema-screen">
      <div className="schema-head">
        <span className="muted schema-stats">
          {t("schema.tableCount", { count: snapshot.relations.length })}
          {" · "}
          {t("schema.fkCount", { count: physicalRelationshipCount })}
        </span>
        <div className="schema-head-actions ds-control-row">
          <input
            className="schema-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("schema.filterPlaceholder")}
            type="search"
          />
          <button
            className={`btn small icon-only${editorOpen ? " active" : ""}`}
            type="button"
            aria-expanded={editorOpen}
            title={t("schema.editorTitle")}
            aria-label={t("schema.editorTitle")}
            onClick={() => setEditorOpen((open) => !open)}
          >
            <Icon name="pencil" />
          </button>
          <button
            className={`btn small icon-only${inspectorOpen ? " active" : ""}`}
            type="button"
            aria-expanded={inspectorOpen}
            aria-controls="schema-inspector"
            title={t(
              inspectorOpen ? "schema.hideDetails" : "schema.showDetails",
            )}
            aria-label={t(
              inspectorOpen ? "schema.hideDetails" : "schema.showDetails",
            )}
            onClick={() => setInspectorOpen((open) => !open)}
          >
            <Icon name="panelRight" />
          </button>
        </div>
      </div>

      {editorOpen && (
        <SchemaEditor
          connectionId={connection.id}
          engine={connection.engine}
          snapshot={snapshot}
          relation={selected}
          safety={safety}
          onClose={() => setEditorOpen(false)}
        />
      )}

      {snapshot.relations.length === 0 ? (
        <div className="muted empty">{t("schema.empty")}</div>
      ) : (
        <div
          className={`schema-layout${inspectorOpen ? " inspector-open" : ""}`}
        >
          <Suspense fallback={<Skeleton lines={8} />}>
            <ErdCanvas
              snapshot={snapshot}
              filter={filter}
              selectedKey={selectedKey}
              onSelect={(relation) =>
                setSelectedKey(erdRelationKey(relation.object))
              }
              onOpen={openRelation}
            />
          </Suspense>
          {inspectorOpen && (
            <aside className="schema-inspector" id="schema-inspector">
              {selected ? (
                <>
                  <div className="schema-inspector-head">
                    <div className="schema-inspector-title">
                      <h3>{relationDisplayName(selected.object)}</h3>
                      <span
                        className="badge schema-stat"
                        title={t("schema.columnCount", {
                          count: selected.columns.length,
                        })}
                      >
                        <Icon name="table" />
                        {selected.columns.length}
                      </span>
                    </div>
                    {legacyTableFor(
                      catalogQueryResult.data.tables,
                      selected,
                    ) && (
                      <button
                        className="btn small"
                        onClick={() => openRelation(selected)}
                      >
                        {t("schema.openData")}
                      </button>
                    )}
                  </div>
                  <div className="schema-detail-list">
                    {selected.columns.map((column) => (
                      <div className="schema-detail-row" key={column.name}>
                        <span>
                          <code>{column.name}</code>
                          {selected.constraints.some(
                            (constraint) =>
                              constraint.kind === "primary" &&
                              constraint.columns.includes(column.name),
                          ) && <b>{t("schema.pk")}</b>}
                        </span>
                        <em>{column.nativeType}</em>
                      </div>
                    ))}
                  </div>
                  <h3>{t("schema.relationships")}</h3>
                  {selected.constraints.some(
                    (constraint) => constraint.kind === "foreign",
                  ) ? (
                    <ul className="schema-rel-list">
                      {selected.constraints
                        .filter(
                          (constraint) => constraint.kind === "foreign",
                        )
                        .map((constraint) => (
                          <li key={constraint.name}>
                            {constraint.name}:{" "}
                            {constraint.columns.join(", ")}
                            {" → "}
                            {constraint.referencedRelation
                              ? relationDisplayName(
                                  constraint.referencedRelation,
                                )
                              : "?"}
                            .{constraint.referencedColumns.join(", ")}
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p className="muted">{t("schema.noForeignKeys")}</p>
                  )}
                  <h3>{t("schema.indexes")}</h3>
                  {selected.indexes.length ? (
                    <ul className="schema-rel-list">
                      {selected.indexes.map((index) => (
                        <li key={index.name}>
                          {index.name}:{" "}
                          {index.keys
                            .map(
                              (key) =>
                                key.column ?? key.expression ?? "?",
                            )
                            .join(", ")}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">{t("common.none")}</p>
                  )}
                </>
              ) : (
                <InfoTip label={t("schema.selectTable")} />
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
