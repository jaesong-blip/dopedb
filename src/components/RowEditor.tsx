// Row editor panel: one input per column (checkbox for SQL NULL, numeric input for
// numeric columns, PK fields readonly on edit). Generates an INSERT/UPDATE via sqlBuild
// and hands the SQL up via onSubmit — the parent routes it through the exact native
// operation pipeline so classify/approve/audit still applies. Never executes directly.
import { useMemo, useState } from "react";
import { Button } from "../design-system/components/Button";
import { TextInput } from "../design-system/components/FormControls";
import { useI18n } from "../lib/i18n";
import {
  InspectorFooter,
  InspectorHeader,
} from "../design-system/components/Workbench";
import { Icon } from "./Icon";
import type { CatalogTable, Engine } from "../ipc/types";
import { buildInsert, buildUpdate, isNumericType, pkColumns } from "../lib/sqlBuild";

type Mode = "insert" | "edit" | "duplicate";

export type RowEditorSubmission = {
  sql: string;
  rationale: string;
  collapseSql: boolean;
};

function shortValue(value: string | null): string {
  if (value === null) return "NULL";
  if (value === "") return "(empty)";
  return value.length > 28 ? `${value.slice(0, 25)}...` : value;
}

export default function RowEditor({
  engine,
  table,
  mode,
  initial,
  onSubmit,
  onCancel,
}: {
  engine: Engine;
  table: CatalogTable;
  mode: Mode;
  initial: Record<string, string | null>; // {} for a fresh insert
  onSubmit: (write: RowEditorSubmission) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  // Only seed columns present in `initial` (edit/duplicate). A fresh insert (initial={})
  // starts empty so untouched columns are OMITTED from the INSERT — letting serial PKs and
  // column defaults fire instead of forcing an invalid '' into every field.
  const [vals, setVals] = useState<Record<string, string | null>>(() => {
    const v: Record<string, string | null> = {};
    for (const c of table.columns) if (c.name in initial) v[c.name] = initial[c.name];
    return v;
  });
  const [error, setError] = useState<string | null>(null);

  const isEdit = mode === "edit";
  const set = (name: string, value: string | null) => setVals((p) => ({ ...p, [name]: value }));
  const changedColumns = useMemo(
    () =>
      isEdit
        ? table.columns.filter((c) => !c.pk && vals[c.name] !== initial[c.name])
        : table.columns.filter((c) => c.name in vals),
    [initial, isEdit, table.columns, vals],
  );
  const changedCount = changedColumns.length;

  function rationaleForEdit(): string {
    if (changedColumns.length === 1) {
      const c = changedColumns[0];
      return t("rowEditor.rationaleFieldChange", {
        col: c.name,
        from: shortValue(initial[c.name] ?? null),
        to: shortValue(vals[c.name] ?? null),
      });
    }
    const names = changedColumns.slice(0, 4).map((c) => c.name);
    const rest =
      changedColumns.length > names.length
        ? t("rowEditor.rationaleMore", { count: changedColumns.length - names.length })
        : "";
    return t("rowEditor.rationaleFieldsChange", { count: changedColumns.length, names: names.join(", "), rest });
  }

  function submit() {
    try {
      let sql: string;
      let rationale: string;
      if (isEdit) {
        if (!changedColumns.length) {
          setError(t("rowEditor.noChanges"));
          return;
        }
        const pkValues: Record<string, string | null> = {};
        for (const c of pkColumns(table)) pkValues[c.name] = initial[c.name] ?? null;
        const setValues: Record<string, string | null> = {};
        for (const c of changedColumns) setValues[c.name] = vals[c.name] ?? null;
        sql = buildUpdate(engine, table, pkValues, setValues, initial);
        rationale = rationaleForEdit();
      } else {
        sql = buildInsert(engine, table, vals);
        rationale = t(
          mode === "duplicate"
            ? changedColumns.length === 1
              ? "rowEditor.rationaleDuplicate"
              : "rowEditor.rationaleDuplicatePlural"
            : changedColumns.length === 1
              ? "rowEditor.rationaleInsert"
              : "rowEditor.rationaleInsertPlural",
          { table: table.name, count: changedColumns.length },
        );
      }
      setError(null);
      onSubmit({ sql, rationale, collapseSql: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const title = t(
    isEdit ? "rowEditor.titleEdit" : mode === "duplicate" ? "rowEditor.titleDuplicate" : "rowEditor.titleInsert",
  );
  const actionText = isEdit
    ? changedCount
      ? t(changedCount === 1 ? "rowEditor.reviewChange" : "rowEditor.reviewChangePlural", { count: changedCount })
      : t("rowEditor.noChanges")
    : t("rowEditor.reviewRow");
  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          onCancel();
        }
      }}
    >
      <InspectorHeader
        title={title}
        metadata={
          isEdit ? (
            <span className="tw:text-muted-foreground">
              {t(changedCount === 1 ? "rowEditor.changeCount" : "rowEditor.changeCountPlural", {
                count: changedCount,
              })}
            </span>
          ) : null
        }
        actions={
          <Button
            iconOnly
            size="xs"
            variant="ghost"
            onClick={onCancel}
            aria-label={t("common.close")}
          >
          <Icon name="close" />
          </Button>
        }
      />
      <div className="tw:mb-3 tw:flex tw:flex-col tw:gap-2">
        {table.columns.filter((c) => !(isEdit && c.pk)).map((c) => {
          const isNull = vals[c.name] === null;
          const readonly = isEdit && c.pk;
          const changed = isEdit && !c.pk && vals[c.name] !== initial[c.name];
          return (
            <div
              data-changed={changed}
              className="tw:data-[changed=true]:border-l-2 tw:data-[changed=true]:border-primary tw:data-[changed=true]:pl-2"
              key={c.name}
            >
              <label
                className="tw:mb-px tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:overflow-hidden tw:text-sm tw:text-ellipsis tw:whitespace-nowrap"
                title={c.dataType}
              >
                {c.name}
                {c.pk && (
                  <span className="tw:rounded-xs tw:border tw:border-primary tw:px-0.5 tw:text-2xs tw:font-bold tw:text-primary">
                    {t("schema.pk")}
                  </span>
                )}
                {changed && (
                  <span className="tw:rounded-xs tw:bg-primary/10 tw:px-1 tw:py-px tw:text-2xs tw:font-bold tw:text-primary tw:uppercase">
                    {t("rowEditor.changedBadge")}
                  </span>
                )}
              </label>
              <div className="tw:flex tw:items-center tw:gap-2 tw:[&>input]:min-w-0 tw:[&>input]:flex-1">
                <TextInput
                  density="compact"
                  type={isNumericType(c.dataType) ? "number" : "text"}
                  value={isNull ? "" : vals[c.name] ?? ""}
                  disabled={isNull || readonly}
                  onChange={(e) => set(c.name, e.target.value)}
                />
                <label
                  data-active={isNull}
                  data-disabled={readonly || !c.nullable}
                  className="tw:relative tw:inline-flex tw:size-control-md tw:shrink-0 tw:cursor-pointer tw:items-center tw:justify-center tw:rounded-sm tw:border tw:border-border-subtle tw:bg-muted tw:text-muted-foreground tw:data-[active=true]:border-primary tw:data-[active=true]:bg-primary/10 tw:data-[active=true]:text-primary tw:data-[disabled=true]:cursor-not-allowed tw:data-[disabled=true]:opacity-35 tw:focus-within:outline-2 tw:focus-within:outline-offset-2 tw:focus-within:outline-ring"
                  title={c.nullable ? "SQL NULL" : t("rowEditor.notNullTitle")}
                >
                  <input
                    className="tw:absolute tw:inset-0 tw:cursor-inherit tw:opacity-0"
                    type="checkbox"
                    aria-label={t("rowEditor.setNullAria", { col: c.name })}
                    checked={isNull}
                    disabled={readonly || !c.nullable}
                    onChange={(e) => set(c.name, e.target.checked ? null : "")}
                  />
                  <Icon name="circleSlash" />
                </label>
              </div>
            </div>
          );
        })}
      </div>
      {error && <div className="tw:text-ui tw:text-danger">{error}</div>}
      <InspectorFooter>
        <Button variant="primary" disabled={isEdit && changedCount === 0} onClick={submit}>
          {actionText}
        </Button>
        <Button onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </InspectorFooter>
    </div>
  );
}
