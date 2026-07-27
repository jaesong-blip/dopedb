import type { Catalog } from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import {
  compareCatalogs,
  defaultSchemaBaseline,
  diffCounts,
  type SchemaConnectionGroup,
  type SchemaDiffSummary,
  type TableSchemaDiff,
} from "../../lib/schemaDiff";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../lib/i18n";

type Translate = ReturnType<typeof useI18n>["t"];

export function schemaDiffForConnection(
  connection: ConnectionProfile,
  groupsByConnectionId: ReadonlyMap<string, SchemaConnectionGroup>,
  catalogs: Record<string, Catalog>,
): SchemaDiffSummary | null {
  const group = groupsByConnectionId.get(connection.id);
  const baseline = group && defaultSchemaBaseline(group);
  if (!baseline || baseline.id === connection.id) return null;
  const current = catalogs[connection.id];
  const baselineCatalog = catalogs[baseline.id];
  return current && baselineCatalog ? compareCatalogs(current, baselineCatalog) : null;
}

export function schemaTableDiffTitle(t: Translate, diff: TableSchemaDiff) {
  if (diff.added) return t("connections.schemaDiffTableAdded");
  if (diff.missing) return t("connections.schemaDiffTableMissing");
  return t("connections.schemaDiffTableChanged", {
    added: diff.addedColumns.length,
    missing: diff.missingColumns.length,
    changed: diff.changedColumns.length + (diff.relationChanged ? 1 : 0),
  });
}

export function SchemaDiffBadge({
  connection,
  groupsByConnectionId,
  catalogs,
}: {
  connection: ConnectionProfile;
  groupsByConnectionId: ReadonlyMap<string, SchemaConnectionGroup>;
  catalogs: Record<string, Catalog>;
}) {
  const { t } = useI18n();
  const group = groupsByConnectionId.get(connection.id);
  const baseline = group && defaultSchemaBaseline(group);
  if (!baseline || baseline.id === connection.id) return null;
  const current = catalogs[connection.id];
  const baselineCatalog = catalogs[baseline.id];
  if (!current || !baselineCatalog) {
    return (
      <span className="schema-diff-chip diff-pending" title={t("connections.schemaDiffPendingTitle")}>
        {t("connections.schemaDiffPendingChip")}
      </span>
    );
  }
  const diff = compareCatalogs(current, baselineCatalog);
  if (diff.total === 0) {
    return (
      <span className="schema-diff-chip diff-ok" title={t("connections.schemaDiffInSync")}>
        <Icon name="check" />
      </span>
    );
  }
  const counts = diffCounts(diff);
  const title = t("connections.schemaDiffTitle", {
    added: counts.added,
    missing: counts.missing,
    changed: counts.changed,
  });
  return (
    <span className="schema-diff-chip diff-drift" title={title}>
      {counts.added > 0 && <span className="diff-add">+{counts.added}</span>}
      {counts.missing > 0 && <span className="diff-remove">-{counts.missing}</span>}
      {counts.changed > 0 && <span className="diff-change">~{counts.changed}</span>}
    </span>
  );
}
