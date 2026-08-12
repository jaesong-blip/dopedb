import { useMemo, useState, type ReactNode } from "react";

import { Icon } from "../../components/Icon";
import { Button } from "../../design-system/components/Button";
import {
  CheckboxField,
  Field,
  SelectInput,
  TextAreaInput,
  TextInput,
} from "../../design-system/components/FormControls";
import { InlineNotice, StatusBadge } from "../../design-system/components/Status";
import { useI18n } from "../../lib/i18n";
import {
  analysisBlockKinds,
  analysisColumnMasking,
  analysisColumnRoles,
  analysisColumnSensitivities,
  analysisColumnTypes,
  analysisParameterTypes,
  analysisTransformOperations,
  type AnalysisArticleConnection,
  type AnalysisArticleDefinition,
  type AnalysisBlock,
  type AnalysisBlockKind,
  type AnalysisColumn,
  type AnalysisMetric,
  type AnalysisNumberFormat,
  type AnalysisParameterType,
  type AnalysisParameterValue,
  type AnalysisTransformNode,
  type AnalysisTransformOperation,
} from "./domain";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PARAMETER_TOKEN = /\{\{([A-Za-z][A-Za-z0-9_-]{0,63})\}\}/g;

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function identifier(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^([^A-Za-z])/, "x_$1");
  return (cleaned || fallback).slice(0, 64);
}

function uniqueIdentifier(label: string, fallback: string, values: readonly string[]): string {
  const base = identifier(label.toLocaleLowerCase(), fallback);
  if (!values.includes(base)) return base;
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${base.slice(0, Math.max(1, 63 - String(suffix).length))}_${suffix}`;
    if (!values.includes(candidate)) return candidate;
  }
  return `${fallback}_${crypto.randomUUID().slice(0, 8)}`;
}

function move<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  return items.map((item, itemIndex) => itemIndex === index ? value : item);
}

function removeAt<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, itemIndex) => itemIndex !== index);
}

function csv(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function defaultColumn(name = "value"): AnalysisColumn {
  return {
    name,
    type: "number",
    nullable: false,
    role: "measure",
    sensitivity: "internal",
    masking: "none",
  };
}

function normalizeColumn(column: AnalysisColumn): AnalysisColumn {
  let masking = column.masking;
  if (column.role === "identifier") masking = column.type === "string" ? "hash" : "redact";
  if (column.role === "free_text" || column.sensitivity === "restricted") masking = "redact";
  if (column.sensitivity === "confidential" && masking === "none") masking = "bucket";
  if (masking === "hash" && column.type !== "string") masking = "redact";
  return { ...column, masking };
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="tw:grid tw:gap-3">
      <header className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
        <span className="tw:grid tw:min-w-0 tw:gap-1">
          <h3 className="tw:m-0 tw:text-sm tw:font-semibold tw:text-foreground">{title}</h3>
          <p className="tw:m-0 tw:max-w-[78ch] tw:text-xs tw:leading-body tw:text-muted-foreground">{description}</p>
        </span>
        {action}
      </header>
      {children}
    </section>
  );
}

function BuilderCard({
  title,
  metadata,
  index,
  count,
  moveUpDisabled = false,
  moveDownDisabled = false,
  removeDisabled = false,
  removeDisabledReason,
  onMove,
  onRemove,
  children,
}: {
  title: string;
  metadata: string;
  index: number;
  count: number;
  moveUpDisabled?: boolean;
  moveDownDisabled?: boolean;
  removeDisabled?: boolean;
  removeDisabledReason?: string;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <article className="tw:grid tw:min-w-0 tw:gap-4 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
      <header className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
        <span className="tw:min-w-0 tw:flex-1">
          <strong className="tw:block tw:truncate tw:text-sm tw:font-medium">{title}</strong>
          <small className="tw:block tw:truncate tw:font-mono tw:text-2xs tw:text-muted-foreground">{metadata}</small>
        </span>
        <Button iconOnly size="xs" variant="ghost" aria-label={t("analysis.builderMoveUp")} disabled={index === 0 || moveUpDisabled} onClick={() => onMove(-1)}>
          <Icon name="caretUp" />
        </Button>
        <Button iconOnly size="xs" variant="ghost" aria-label={t("analysis.builderMoveDown")} disabled={index === count - 1 || moveDownDisabled} onClick={() => onMove(1)}>
          <Icon name="caretDown" />
        </Button>
        <Button iconOnly size="xs" variant="dangerGhost" aria-label={t("analysis.builderRemove", { title })} title={removeDisabledReason} disabled={removeDisabled} onClick={onRemove}>
          <Icon name="trash" />
        </Button>
      </header>
      {children}
    </article>
  );
}

function EmptyBuilder({ children }: { children: ReactNode }) {
  return (
    <p className="tw:m-0 tw:rounded-md tw:border tw:border-dashed tw:border-border-subtle tw:px-4 tw:py-5 tw:text-center tw:text-xs tw:leading-body tw:text-muted-foreground">
      {children}
    </p>
  );
}

function FormGrid({ children }: { children: ReactNode }) {
  return <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[640px]:grid-cols-1">{children}</div>;
}

function ColumnEditor({
  columns,
  onChange,
}: {
  columns: readonly AnalysisColumn[];
  onChange: (columns: AnalysisColumn[]) => void;
}) {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<AnalysisColumn>) => {
    onChange(replaceAt(columns, index, normalizeColumn({ ...columns[index]!, ...patch })));
  };
  return (
    <details className="tw:min-w-0 tw:rounded-md tw:border tw:border-border-subtle tw:bg-background" open>
      <summary className="tw:flex tw:cursor-pointer tw:items-center tw:justify-between tw:gap-3 tw:px-3 tw:py-2 tw:text-xs tw:font-medium">
        <span>{t("analysis.builderDeclaredSchema", { count: columns.length })}</span>
      </summary>
      <div className="tw:grid tw:gap-2 tw:border-t tw:border-border-subtle tw:p-3">
        {columns.map((column, index) => (
          <div className="tw:grid tw:grid-cols-[minmax(120px,1.3fr)_repeat(4,minmax(92px,1fr))_auto_auto] tw:items-center tw:gap-2 tw:@max-[900px]:grid-cols-2" key={`${index}:${column.name}`}>
            <TextInput density="compact" aria-label={t("analysis.builderColumnName")} value={column.name} onChange={(event) => update(index, { name: event.target.value })} />
            <SelectInput density="compact" aria-label={t("analysis.builderColumnType")} value={column.type} onChange={(event) => update(index, { type: event.target.value as AnalysisColumn["type"] })}>
              {analysisColumnTypes.map((value) => <option value={value} key={value}>{value}</option>)}
            </SelectInput>
            <SelectInput density="compact" aria-label={t("analysis.builderColumnRole")} value={column.role} onChange={(event) => update(index, { role: event.target.value as AnalysisColumn["role"] })}>
              {analysisColumnRoles.map((value) => <option value={value} key={value}>{humanize(value)}</option>)}
            </SelectInput>
            <SelectInput density="compact" aria-label={t("analysis.builderColumnSensitivity")} value={column.sensitivity} onChange={(event) => update(index, { sensitivity: event.target.value as AnalysisColumn["sensitivity"] })}>
              {analysisColumnSensitivities.map((value) => <option value={value} key={value}>{value}</option>)}
            </SelectInput>
            <SelectInput density="compact" aria-label={t("analysis.builderColumnMasking")} value={column.masking} onChange={(event) => update(index, { masking: event.target.value as AnalysisColumn["masking"] })}>
              {analysisColumnMasking.map((value) => <option value={value} key={value}>{value}</option>)}
            </SelectInput>
            <CheckboxField label={t("analysis.builderNullable")} checked={column.nullable} onChange={(event) => update(index, { nullable: event.target.checked })} />
            <Button iconOnly size="xs" variant="dangerGhost" aria-label={t("analysis.builderRemove", { title: column.name })} disabled={columns.length === 1} onClick={() => onChange(removeAt(columns, index))}>
              <Icon name="trash" />
            </Button>
          </div>
        ))}
        <Button size="compact" onClick={() => onChange([...columns, defaultColumn(uniqueIdentifier("column", "column", columns.map((column) => column.name)))])}>
          <Icon name="plus" /> {t("analysis.builderAddColumn")}
        </Button>
      </div>
    </details>
  );
}

function parameterDefault(type: AnalysisParameterType): AnalysisParameterValue {
  if (type === "boolean") return false;
  if (type === "number") return 0;
  if (type === "date") return new Date().toISOString().slice(0, 10);
  if (type === "datetime") return new Date().toISOString();
  if (type === "enum") return "all";
  return "";
}

function parseParameterDefault(type: AnalysisParameterType, value: string): AnalysisParameterValue {
  if (type === "number") return value.trim() === "" ? 0 : Number(value);
  if (type === "boolean") return value === "true";
  return value;
}

function renameParameter(
  definition: AnalysisArticleDefinition,
  oldId: string,
  nextId: string,
): AnalysisArticleDefinition {
  if (oldId === nextId) return definition;
  return {
    ...definition,
    parameters: definition.parameters.map((parameter) => parameter.id === oldId ? { ...parameter, id: nextId } : parameter),
    queries: definition.queries.map((query) => ({
      ...query,
      sql: query.sql.split(`{{${oldId}}}`).join(`{{${nextId}}}`),
      parameterIds: query.parameterIds.map((id) => id === oldId ? nextId : id),
    })),
    blocks: definition.blocks.map((block) => {
      if (!["date_range_control", "comparison_control", "segment_control"].includes(block.kind)) return block;
      const parameterIds = Array.isArray(block.config.parameterIds)
        ? block.config.parameterIds.map((id) => id === oldId ? nextId : id)
        : [];
      return { ...block, config: { ...block.config, parameterIds } };
    }),
  };
}

function renameNode(
  definition: AnalysisArticleDefinition,
  oldId: string,
  nextId: string,
): AnalysisArticleDefinition {
  if (oldId === nextId) return definition;
  return {
    ...definition,
    queries: definition.queries.map((query) => query.id === oldId ? { ...query, id: nextId } : query),
    transforms: definition.transforms.map((transform) => ({
      ...transform,
      id: transform.id === oldId ? nextId : transform.id,
      inputNodeIds: transform.inputNodeIds.map((id) => id === oldId ? nextId : id),
    })),
    metrics: definition.metrics.map((metric) => metric.sourceNodeId === oldId ? { ...metric, sourceNodeId: nextId } : metric),
    blocks: definition.blocks.map((block) => block.sourceNodeId === oldId ? { ...block, sourceNodeId: nextId } : block),
    claims: definition.claims.map((claim) => ({
      ...claim,
      nodeIds: claim.nodeIds.map((id) => id === oldId ? nextId : id),
    })),
  };
}

function renameBlock(
  definition: AnalysisArticleDefinition,
  oldId: string,
  nextId: string,
): AnalysisArticleDefinition {
  if (oldId === nextId) return definition;
  return {
    ...definition,
    blocks: definition.blocks.map((block) => block.id === oldId ? { ...block, id: nextId } : block),
    claims: definition.claims.map((claim) => ({
      ...claim,
      blockIds: claim.blockIds.map((id) => id === oldId ? nextId : id),
    })),
  };
}

function renameMetric(
  definition: AnalysisArticleDefinition,
  oldId: string,
  nextId: string,
): AnalysisArticleDefinition {
  if (oldId === nextId) return definition;
  return {
    ...definition,
    metrics: definition.metrics.map((metric) => metric.id === oldId ? { ...metric, id: nextId } : metric),
    blocks: definition.blocks.map((block) => block.kind === "metric" && block.config.metricId === oldId
      ? { ...block, config: { ...block.config, metricId: nextId } }
      : block),
  };
}

function parameterReferenced(definition: AnalysisArticleDefinition, parameterId: string): boolean {
  return definition.queries.some((query) => query.parameterIds.includes(parameterId))
    || definition.blocks.some((block) => Array.isArray(block.config.parameterIds)
      && block.config.parameterIds.includes(parameterId));
}

function nodeReferenced(definition: AnalysisArticleDefinition, nodeId: string): boolean {
  return definition.transforms.some((transform) => transform.inputNodeIds.includes(nodeId))
    || definition.metrics.some((metric) => metric.sourceNodeId === nodeId)
    || definition.blocks.some((block) => block.sourceNodeId === nodeId)
    || definition.claims.some((claim) => claim.nodeIds.includes(nodeId));
}

function metricReferenced(definition: AnalysisArticleDefinition, metricId: string): boolean {
  return definition.blocks.some((block) => block.kind === "metric" && block.config.metricId === metricId);
}

function blockReferenced(definition: AnalysisArticleDefinition, blockId: string): boolean {
  return definition.claims.some((claim) => claim.blockIds.includes(blockId));
}

function transformOrderValid(
  definition: AnalysisArticleDefinition,
  transforms: readonly AnalysisTransformNode[],
): boolean {
  const known = new Set(definition.queries.map((query) => query.id));
  return transforms.every((transform) => {
    if (transform.inputNodeIds.some((id) => !known.has(id))) return false;
    known.add(transform.id);
    return true;
  });
}

export function AnalysisDataContractEditor({
  definition,
  connections,
  onChange,
}: {
  definition: AnalysisArticleDefinition;
  connections: readonly AnalysisArticleConnection[];
  onChange: (definition: AnalysisArticleDefinition) => void;
}) {
  const { t } = useI18n();
  const addParameter = () => {
    const id = uniqueIdentifier("parameter", "parameter", definition.parameters.map((parameter) => parameter.id));
    onChange({
      ...definition,
      parameters: [...definition.parameters, {
        id,
        label: "Parameter",
        type: "string",
        required: true,
        defaultValue: "",
        options: [],
      }],
    });
  };
  const addQuery = () => {
    const id = uniqueIdentifier("query", "query", [
      ...definition.queries.map((query) => query.id),
      ...definition.transforms.map((transform) => transform.id),
    ]);
    onChange({
      ...definition,
      queries: [...definition.queries, {
        id,
        title: "Read query",
        connectionRole: connections[0]?.role ?? "primary",
        sql: "SELECT 1 AS value",
        parameterIds: [],
        maxRows: 5_000,
        maxBytes: 4 * 1024 * 1024,
        cacheTtlSeconds: 0,
        columns: [defaultColumn()],
      }],
    });
  };
  return (
    <div className="tw:grid tw:gap-7">
      <Section
        title={t("analysis.builderParameters")}
        description={t("analysis.builderParametersBody")}
        action={<Button size="compact" onClick={addParameter}><Icon name="plus" /> {t("analysis.builderAddParameter")}</Button>}
      >
        {definition.parameters.length === 0 ? <EmptyBuilder>{t("analysis.builderParametersEmpty")}</EmptyBuilder> : (
          <div className="tw:grid tw:gap-3">
            {definition.parameters.map((parameter, index) => (
              <BuilderCard
                key={`${index}:${parameter.id}`}
                title={parameter.label || parameter.id}
                metadata={`{{${parameter.id}}} · ${parameter.type}`}
                index={index}
                count={definition.parameters.length}
                removeDisabled={parameterReferenced(definition, parameter.id)}
                removeDisabledReason={t("analysis.builderParameterRemoveBlocked")}
                onMove={(direction) => onChange({ ...definition, parameters: move(definition.parameters, index, direction) })}
                onRemove={() => onChange({ ...definition, parameters: removeAt(definition.parameters, index) })}
              >
                <FormGrid>
                  <Field label="ID" validation={!IDENTIFIER.test(parameter.id) ? { tone: "danger", message: t("analysis.builderIdentifierRule") } : undefined}>
                    <TextInput value={parameter.id} onChange={(event) => onChange(renameParameter(definition, parameter.id, event.target.value))} />
                  </Field>
                  <Field label={t("analysis.builderLabel")}><TextInput value={parameter.label} onChange={(event) => onChange({ ...definition, parameters: replaceAt(definition.parameters, index, { ...parameter, label: event.target.value }) })} /></Field>
                  <Field label={t("analysis.builderType")}>
                    <SelectInput value={parameter.type} onChange={(event) => {
                      const type = event.target.value as AnalysisParameterType;
                      const options = type === "enum" ? parameter.options.length ? parameter.options : ["all"] : [];
                      onChange({ ...definition, parameters: replaceAt(definition.parameters, index, {
                        ...parameter,
                        type,
                        options,
                        defaultValue: type === "enum" ? options[0]! : parameterDefault(type),
                      }) });
                    }}>
                      {analysisParameterTypes.map((value) => <option value={value} key={value}>{value}</option>)}
                    </SelectInput>
                  </Field>
                  {parameter.type === "boolean" ? (
                    <Field label={t("analysis.builderDefault")}>
                      <SelectInput value={String(parameter.defaultValue)} onChange={(event) => onChange({ ...definition, parameters: replaceAt(definition.parameters, index, { ...parameter, defaultValue: event.target.value === "true" }) })}>
                        <option value="true">true</option><option value="false">false</option>
                      </SelectInput>
                    </Field>
                  ) : parameter.type === "enum" ? (
                    <Field label={t("analysis.builderDefault")}>
                      <SelectInput value={String(parameter.defaultValue ?? "")} onChange={(event) => onChange({ ...definition, parameters: replaceAt(definition.parameters, index, { ...parameter, defaultValue: event.target.value }) })}>
                        {parameter.options.map((option) => <option value={option} key={option}>{option}</option>)}
                      </SelectInput>
                    </Field>
                  ) : (
                    <Field label={t("analysis.builderDefault")}>
                      <TextInput
                        type={parameter.type === "number" ? "number" : parameter.type === "date" ? "date" : parameter.type === "datetime" ? "datetime-local" : "text"}
                        value={typeof parameter.defaultValue === "string" || typeof parameter.defaultValue === "number" ? parameter.defaultValue : ""}
                        onChange={(event) => onChange({ ...definition, parameters: replaceAt(definition.parameters, index, { ...parameter, defaultValue: parseParameterDefault(parameter.type, event.target.value) }) })}
                      />
                    </Field>
                  )}
                  {parameter.type === "enum" ? (
                    <Field label={t("analysis.builderAllowedOptions")} hint={<span className="tw:text-xs tw:font-normal">{t("analysis.builderCommaSeparated")}</span>}>
                      <TextInput value={parameter.options.join(", ")} onChange={(event) => {
                        const options = csv(event.target.value);
                        onChange({ ...definition, parameters: replaceAt(definition.parameters, index, {
                          ...parameter,
                          options,
                          defaultValue: options.includes(String(parameter.defaultValue)) ? parameter.defaultValue : options[0] ?? "",
                        }) });
                      }} />
                    </Field>
                  ) : null}
                </FormGrid>
                <CheckboxField label={t("analysis.builderRequiredEveryRun")} checked={parameter.required} onChange={(event) => onChange({ ...definition, parameters: replaceAt(definition.parameters, index, { ...parameter, required: event.target.checked }) })} />
              </BuilderCard>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={t("analysis.builderReadQueries")}
        description={t("analysis.builderReadQueriesBody")}
        action={<Button size="compact" onClick={addQuery}><Icon name="plus" /> {t("analysis.builderAddQuery")}</Button>}
      >
        <div className="tw:grid tw:gap-3">
          {definition.queries.map((query, index) => {
            const tokens = [...query.sql.matchAll(PARAMETER_TOKEN)].map((match) => match[1]!);
            const unknown = tokens.filter((token) => !definition.parameters.some((parameter) => parameter.id === token));
            return (
              <BuilderCard
                key={`${index}:${query.id}`}
                title={query.title || query.id}
                metadata={`${query.id} · ${query.connectionRole} · ${t("analysis.builderColumnsCount", { count: query.columns.length })}`}
                index={index}
                count={definition.queries.length}
                removeDisabled={definition.queries.length === 1 || nodeReferenced(definition, query.id)}
                removeDisabledReason={definition.queries.length === 1 ? t("analysis.builderQueryRequired") : t("analysis.builderNodeRemoveBlocked")}
                onMove={(direction) => onChange({ ...definition, queries: move(definition.queries, index, direction) })}
                onRemove={() => onChange({ ...definition, queries: removeAt(definition.queries, index) })}
              >
                <FormGrid>
                  <Field label={t("analysis.builderNodeId")} validation={!IDENTIFIER.test(query.id) ? { tone: "danger", message: t("analysis.builderInvalidNodeId") } : undefined}>
                    <TextInput value={query.id} onChange={(event) => onChange(renameNode(definition, query.id, event.target.value))} />
                  </Field>
                  <Field label={t("analysis.fieldTitle")}><TextInput value={query.title} onChange={(event) => onChange({ ...definition, queries: replaceAt(definition.queries, index, { ...query, title: event.target.value }) })} /></Field>
                  <Field label={t("analysis.builderConnectionRole")}>
                    <SelectInput value={query.connectionRole} onChange={(event) => onChange({ ...definition, queries: replaceAt(definition.queries, index, { ...query, connectionRole: event.target.value }) })}>
                      {connections.map((connection) => <option value={connection.role} key={connection.connectionId}>{connection.alias} · {connection.role}</option>)}
                    </SelectInput>
                  </Field>
                  <Field label={t("analysis.builderMaximumRows")}><TextInput type="number" min={1} max={50_000} value={query.maxRows} onChange={(event) => onChange({ ...definition, queries: replaceAt(definition.queries, index, { ...query, maxRows: event.target.valueAsNumber }) })} /></Field>
                  <Field label={t("analysis.builderMaximumBytes")}><TextInput type="number" min={1_024} max={16 * 1024 * 1024} value={query.maxBytes} onChange={(event) => onChange({ ...definition, queries: replaceAt(definition.queries, index, { ...query, maxBytes: event.target.valueAsNumber }) })} /></Field>
                  <Field label={t("analysis.builderCacheTtl")}><TextInput type="number" min={0} max={7 * 24 * 60 * 60} value={query.cacheTtlSeconds} onChange={(event) => onChange({ ...definition, queries: replaceAt(definition.queries, index, { ...query, cacheTtlSeconds: event.target.valueAsNumber }) })} /></Field>
                </FormGrid>
                <Field
                  label={t("analysis.builderReadOnlySql")}
                  hint={<span className="tw:text-xs tw:font-normal tw:text-muted-foreground">{t("analysis.builderSqlTokenHint")}</span>}
                  validation={unknown.length ? { tone: "danger", message: t("analysis.builderUnknownParameters", { parameters: unknown.join(", ") }) } : undefined}
                >
                  <TextAreaInput
                    spellCheck={false}
                    value={query.sql}
                    onChange={(event) => {
                      const sql = event.target.value;
                      const parameterIds = [...new Set([...sql.matchAll(PARAMETER_TOKEN)].map((match) => match[1]!))]
                        .filter((id) => definition.parameters.some((parameter) => parameter.id === id));
                      onChange({ ...definition, queries: replaceAt(definition.queries, index, { ...query, sql, parameterIds }) });
                    }}
                  />
                </Field>
                {tokens.length ? <div className="tw:flex tw:flex-wrap tw:gap-1">{[...new Set(tokens)].map((token) => <StatusBadge density="compact" tone={unknown.includes(token) ? "danger" : "neutral"} key={token}>{`{{${token}}}`}</StatusBadge>)}</div> : null}
                <ColumnEditor columns={query.columns} onChange={(columns) => onChange({ ...definition, queries: replaceAt(definition.queries, index, { ...query, columns }) })} />
              </BuilderCard>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

type NodeOption = {
  id: string;
  title: string;
  columns: AnalysisColumn[];
};

function availableNodes(definition: AnalysisArticleDefinition, transformIndex?: number): NodeOption[] {
  return [
    ...definition.queries.map((query) => ({ id: query.id, title: query.title, columns: query.columns })),
    ...definition.transforms
      .slice(0, transformIndex ?? definition.transforms.length)
      .map((transform) => ({ id: transform.id, title: transform.title, columns: transform.columns })),
  ];
}

function configString(config: Record<string, unknown>, key: string): string {
  return typeof config[key] === "string" ? config[key] as string : "";
}

function configNullableString(config: Record<string, unknown>, key: string): string | null {
  return typeof config[key] === "string" ? config[key] as string : null;
}

function configStrings(config: Record<string, unknown>, key: string): string[] {
  return Array.isArray(config[key]) ? (config[key] as unknown[]).filter((value): value is string => typeof value === "string") : [];
}

function configNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  return typeof config[key] === "number" && Number.isFinite(config[key]) ? config[key] as number : fallback;
}

function configBoolean(config: Record<string, unknown>, key: string, fallback = false): boolean {
  return typeof config[key] === "boolean" ? config[key] as boolean : fallback;
}

function configRows<T extends Record<string, unknown>>(config: Record<string, unknown>, key: string): T[] {
  return Array.isArray(config[key])
    ? (config[key] as unknown[]).filter((value): value is T => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    : [];
}

function derivedMeasure(name: string, inputs: readonly AnalysisColumn[], type: AnalysisColumn["type"] = "number"): AnalysisColumn {
  const sensitivityOrder: AnalysisColumn["sensitivity"][] = ["public", "internal", "confidential", "restricted"];
  const sensitivity = inputs.reduce<AnalysisColumn["sensitivity"]>((current, column) => (
    sensitivityOrder.indexOf(column.sensitivity) > sensitivityOrder.indexOf(current) ? column.sensitivity : current
  ), "public");
  return normalizeColumn({
    name,
    type,
    nullable: inputs.some((column) => column.nullable),
    role: "measure",
    sensitivity,
    masking: sensitivity === "restricted" ? "redact" : sensitivity === "confidential" ? "bucket" : "none",
  });
}

function defaultTransformConfig(
  operation: AnalysisTransformOperation,
  inputs: readonly NodeOption[],
): Record<string, unknown> {
  const first = inputs[0]?.columns ?? [defaultColumn()];
  const second = inputs[1]?.columns ?? first;
  const firstName = first[0]?.name ?? "value";
  const measureNames = first.filter((column) => column.role === "measure").map((column) => column.name);
  const dimensionName = first.find((column) => column.role === "dimension" || column.role === "identifier")?.name ?? firstName;
  const timeName = first.find((column) => column.role === "time")?.name ?? firstName;
  if (operation === "project") return { columns: [firstName] };
  if (operation === "filter") return { column: firstName, operator: "eq", value: null };
  if (operation === "sort") return { columns: [{ column: firstName, direction: "asc" }] };
  if (operation === "limit") return { count: 100 };
  if (operation === "union") return { all: true, mappingProposalId: "" };
  if (operation === "group") return { columns: [dimensionName] };
  if (operation === "aggregate") return {
    groupBy: [dimensionName],
    measures: [{ column: measureNames[0] ?? firstName, function: "sum", as: "total" }],
  };
  if (operation === "inner_join" || operation === "left_join") return {
    mappingProposalId: "",
    keys: [{ left: firstName, right: second[0]?.name ?? firstName }],
  };
  if (operation === "window") return {
    partitionBy: [],
    orderBy: timeName,
    measures: [{ column: null, function: "row_number", as: "row_number" }],
  };
  if (operation === "lag") return {
    column: measureNames[0] ?? firstName,
    offset: 1,
    partitionBy: [],
    orderBy: timeName,
    as: "previous_value",
  };
  if (operation === "ratio" || operation === "difference" || operation === "rate") return {
    numerator: measureNames[0] ?? firstName,
    denominator: measureNames[1] ?? measureNames[0] ?? firstName,
    as: operation,
  };
  if (operation === "cohort") return {
    entityColumn: dimensionName,
    eventTimeColumn: timeName,
    cohortUnit: "month",
    as: "cohort",
  };
  return {
    entityColumn: dimensionName,
    cohortColumn: first.find((column) => column.name === "cohort")?.name ?? dimensionName,
    eventTimeColumn: timeName,
    periodUnit: "month",
    periods: 12,
    as: "retention_period",
  };
}

function deriveTransformColumns(
  transform: Pick<AnalysisTransformNode, "operation" | "inputNodeIds" | "config">,
  nodes: readonly NodeOption[],
): AnalysisColumn[] {
  const inputColumns = transform.inputNodeIds.map((id) => nodes.find((node) => node.id === id)?.columns ?? []);
  const first = inputColumns[0] ?? [];
  const second = inputColumns[1] ?? [];
  const config = transform.config;
  if (["filter", "sort", "limit", "union"].includes(transform.operation)) return structuredClone(first);
  if (transform.operation === "project" || transform.operation === "group") {
    const selected = new Set(configStrings(config, "columns"));
    return structuredClone(first.filter((column) => selected.has(column.name)));
  }
  if (transform.operation === "inner_join" || transform.operation === "left_join") {
    return structuredClone([...first, ...second]);
  }
  if (transform.operation === "aggregate") {
    const groupBy = new Set(configStrings(config, "groupBy"));
    const groups = first.filter((column) => groupBy.has(column.name));
    const measures = configRows<{ column: string; function: string; as: string }>(config, "measures").map((measure) => {
      const source = first.find((column) => column.name === measure.column);
      const outputType = ["count", "count_distinct"].includes(measure.function) ? "number" : source?.type ?? "number";
      return derivedMeasure(measure.as, source ? [source] : [], outputType);
    });
    return [...structuredClone(groups), ...measures];
  }
  if (transform.operation === "window") {
    const added = configRows<{ column: string | null; function: string; as: string }>(config, "measures").map((measure) => {
      const source = measure.column ? first.find((column) => column.name === measure.column) : null;
      return derivedMeasure(measure.as, source ? [source] : [], "number");
    });
    return [...structuredClone(first), ...added];
  }
  if (transform.operation === "lag") {
    const source = first.find((column) => column.name === configString(config, "column"));
    return [...structuredClone(first), source ? { ...source, name: configString(config, "as") } : defaultColumn(configString(config, "as") || "previous_value")];
  }
  if (["ratio", "difference", "rate"].includes(transform.operation)) {
    const sources = [configString(config, "numerator"), configString(config, "denominator")]
      .flatMap((name) => first.filter((column) => column.name === name));
    return [...structuredClone(first), derivedMeasure(configString(config, "as") || transform.operation, sources)];
  }
  if (transform.operation === "cohort") {
    const source = first.find((column) => column.name === configString(config, "eventTimeColumn"));
    return [...structuredClone(first), normalizeColumn({
      ...(source ?? { ...defaultColumn(), type: "date", role: "dimension" as const }),
      name: configString(config, "as") || "cohort",
      type: "date",
      role: "dimension",
    })];
  }
  return [...structuredClone(first), derivedMeasure(configString(config, "as") || "retention_period", [])];
}

function ColumnChecklist({
  columns,
  selected,
  onChange,
}: {
  columns: readonly AnalysisColumn[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
}) {
  return (
    <div className="tw:flex tw:flex-wrap tw:gap-x-4 tw:gap-y-2 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-background tw:p-2">
      {columns.map((column) => (
        <CheckboxField
          key={column.name}
          label={column.name}
          checked={selected.includes(column.name)}
          onChange={(event) => onChange(event.target.checked
            ? [...selected, column.name]
            : selected.filter((name) => name !== column.name))}
        />
      ))}
    </div>
  );
}

function TransformConfigEditor({
  transform,
  inputs,
  onChange,
}: {
  transform: AnalysisTransformNode;
  inputs: readonly NodeOption[];
  onChange: (config: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const config = transform.config;
  const first = inputs[0]?.columns ?? [];
  const second = inputs[1]?.columns ?? [];
  const patch = (value: Record<string, unknown>) => onChange({ ...config, ...value });
  if (transform.operation === "project" || transform.operation === "group") {
    return (
      <Field label={transform.operation === "project" ? t("analysis.builderProjectedColumns") : t("analysis.builderGroupColumns")}>
        <ColumnChecklist columns={first} selected={configStrings(config, "columns")} onChange={(columns) => patch({ columns })} />
      </Field>
    );
  }
  if (transform.operation === "filter") {
    const selectedColumn = first.find((column) => column.name === configString(config, "column"));
    const operator = configString(config, "operator") || "eq";
    const value = config.value;
    return (
      <FormGrid>
        <Field label={t("analysis.builderColumn")}><SelectInput value={configString(config, "column")} onChange={(event) => patch({ column: event.target.value })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
        <Field label={t("analysis.builderOperator")}><SelectInput value={operator} onChange={(event) => patch({ operator: event.target.value, value: ["is_null", "not_null"].includes(event.target.value) ? null : value })}>{["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "not_null"].map((item) => <option value={item} key={item}>{humanize(item)}</option>)}</SelectInput></Field>
        {!['is_null', 'not_null'].includes(operator) ? <Field label={t("analysis.builderValue")}><TextInput value={Array.isArray(value) ? value.join(", ") : value === null || value === undefined ? "" : String(value)} onChange={(event) => {
          const raw = event.target.value;
          const parsed = operator === "in" ? csv(raw) : selectedColumn?.type === "number" ? Number(raw) : selectedColumn?.type === "boolean" ? raw === "true" : raw;
          patch({ value: parsed });
        }} /></Field> : null}
      </FormGrid>
    );
  }
  if (transform.operation === "sort") {
    const rows = configRows<{ column: string; direction: string }>(config, "columns");
    return (
      <Field label={t("analysis.builderSortOrder")}>
        <div className="tw:grid tw:gap-2">
          {rows.map((row, index) => <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_140px_auto] tw:gap-2" key={index}>
            <SelectInput value={row.column} onChange={(event) => patch({ columns: replaceAt(rows, index, { ...row, column: event.target.value }) })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput>
            <SelectInput value={row.direction} onChange={(event) => patch({ columns: replaceAt(rows, index, { ...row, direction: event.target.value }) })}><option value="asc">{t("analysis.builderAscending")}</option><option value="desc">{t("analysis.builderDescending")}</option></SelectInput>
            <Button iconOnly variant="dangerGhost" aria-label={t("analysis.builderRemoveSort")} disabled={rows.length === 1} onClick={() => patch({ columns: removeAt(rows, index) })}><Icon name="trash" /></Button>
          </div>)}
          <Button size="compact" onClick={() => patch({ columns: [...rows, { column: first[0]?.name ?? "", direction: "asc" }] })}><Icon name="plus" /> {t("analysis.builderAddSort")}</Button>
        </div>
      </Field>
    );
  }
  if (transform.operation === "limit") {
    return <Field label={t("analysis.builderMaximumRows")}><TextInput type="number" min={1} max={50_000} value={configNumber(config, "count", 100)} onChange={(event) => patch({ count: event.target.valueAsNumber })} /></Field>;
  }
  if (transform.operation === "union") {
    return (
      <FormGrid>
        <Field label={t("analysis.builderMappingId")} validation={!/^[0-9a-f-]{36}$/i.test(configString(config, "mappingProposalId")) ? { tone: "danger", message: t("analysis.builderMappingIdHint") } : undefined}><TextInput value={configString(config, "mappingProposalId")} onChange={(event) => patch({ mappingProposalId: event.target.value })} /></Field>
        <CheckboxField label={t("analysis.builderUnionAll")} checked={configBoolean(config, "all", true)} onChange={(event) => patch({ all: event.target.checked })} />
      </FormGrid>
    );
  }
  if (transform.operation === "aggregate") {
    const measures = configRows<{ column: string; function: string; as: string }>(config, "measures");
    return (
      <div className="tw:grid tw:gap-3">
        <Field label={t("analysis.builderGroupBy")}><ColumnChecklist columns={first} selected={configStrings(config, "groupBy")} onChange={(groupBy) => patch({ groupBy })} /></Field>
        <Field label={t("analysis.builderMeasures")}>
          <div className="tw:grid tw:gap-2">
            {measures.map((measure, index) => <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_160px_minmax(120px,1fr)_auto] tw:gap-2 tw:@max-[700px]:grid-cols-1" key={index}>
              <SelectInput value={measure.column} onChange={(event) => patch({ measures: replaceAt(measures, index, { ...measure, column: event.target.value }) })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput>
              <SelectInput value={measure.function} onChange={(event) => patch({ measures: replaceAt(measures, index, { ...measure, function: event.target.value }) })}>{["count", "count_distinct", "sum", "avg", "min", "max"].map((value) => <option value={value} key={value}>{humanize(value)}</option>)}</SelectInput>
              <TextInput aria-label={t("analysis.builderOutputColumn")} value={measure.as} onChange={(event) => patch({ measures: replaceAt(measures, index, { ...measure, as: event.target.value }) })} />
              <Button iconOnly variant="dangerGhost" aria-label={t("analysis.builderRemoveMeasure")} disabled={measures.length === 1} onClick={() => patch({ measures: removeAt(measures, index) })}><Icon name="trash" /></Button>
            </div>)}
            <Button size="compact" onClick={() => patch({ measures: [...measures, { column: first[0]?.name ?? "", function: "sum", as: uniqueIdentifier("measure", "measure", measures.map((measure) => measure.as)) }] })}><Icon name="plus" /> {t("analysis.builderAddMeasure")}</Button>
          </div>
        </Field>
      </div>
    );
  }
  if (transform.operation === "inner_join" || transform.operation === "left_join") {
    const keys = configRows<{ left: string; right: string }>(config, "keys");
    return (
      <div className="tw:grid tw:gap-3">
        <Field label={t("analysis.builderMappingId")} validation={!/^[0-9a-f-]{36}$/i.test(configString(config, "mappingProposalId")) ? { tone: "danger", message: t("analysis.builderMappingIdRequired") } : undefined}><TextInput value={configString(config, "mappingProposalId")} onChange={(event) => patch({ mappingProposalId: event.target.value })} /></Field>
        <Field label={t("analysis.builderJoinKeys")}>
          <div className="tw:grid tw:gap-2">
            {keys.map((key, index) => <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] tw:items-center tw:gap-2" key={index}>
              <SelectInput value={key.left} onChange={(event) => patch({ keys: replaceAt(keys, index, { ...key, left: event.target.value }) })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput>
              <span className="tw:text-xs tw:text-muted-foreground">=</span>
              <SelectInput value={key.right} onChange={(event) => patch({ keys: replaceAt(keys, index, { ...key, right: event.target.value }) })}>{second.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput>
              <Button iconOnly variant="dangerGhost" aria-label={t("analysis.builderRemoveJoinKey")} disabled={keys.length === 1} onClick={() => patch({ keys: removeAt(keys, index) })}><Icon name="trash" /></Button>
            </div>)}
            <Button size="compact" onClick={() => patch({ keys: [...keys, { left: first[0]?.name ?? "", right: second[0]?.name ?? "" }] })}><Icon name="plus" /> {t("analysis.builderAddKey")}</Button>
          </div>
        </Field>
      </div>
    );
  }
  if (transform.operation === "window") {
    const measures = configRows<{ column: string | null; function: string; as: string }>(config, "measures");
    return (
      <div className="tw:grid tw:gap-3">
        <Field label={t("analysis.builderPartitionBy")}><ColumnChecklist columns={first} selected={configStrings(config, "partitionBy")} onChange={(partitionBy) => patch({ partitionBy })} /></Field>
        <Field label={t("analysis.builderOrderBy")}><SelectInput value={configString(config, "orderBy")} onChange={(event) => patch({ orderBy: event.target.value })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
        <Field label={t("analysis.builderWindowMeasures")}>
          <div className="tw:grid tw:gap-2">
            {measures.map((measure, index) => <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_180px_minmax(120px,1fr)_auto] tw:gap-2 tw:@max-[700px]:grid-cols-1" key={index}>
              <SelectInput value={measure.column ?? ""} onChange={(event) => patch({ measures: replaceAt(measures, index, { ...measure, column: event.target.value || null }) })}><option value="">{t("analysis.builderNoSourceColumn")}</option>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput>
              <SelectInput value={measure.function} onChange={(event) => patch({ measures: replaceAt(measures, index, { ...measure, function: event.target.value }) })}>{["row_number", "rank", "dense_rank", "running_sum", "running_avg"].map((value) => <option value={value} key={value}>{humanize(value)}</option>)}</SelectInput>
              <TextInput aria-label={t("analysis.builderOutputColumn")} value={measure.as} onChange={(event) => patch({ measures: replaceAt(measures, index, { ...measure, as: event.target.value }) })} />
              <Button iconOnly variant="dangerGhost" aria-label={t("analysis.builderRemoveWindowMeasure")} disabled={measures.length === 1} onClick={() => patch({ measures: removeAt(measures, index) })}><Icon name="trash" /></Button>
            </div>)}
            <Button size="compact" onClick={() => patch({ measures: [...measures, { column: null, function: "row_number", as: uniqueIdentifier("window_value", "window_value", measures.map((measure) => measure.as)) }] })}><Icon name="plus" /> {t("analysis.builderAddWindowMeasure")}</Button>
          </div>
        </Field>
      </div>
    );
  }
  if (transform.operation === "lag") {
    return (
      <FormGrid>
        <Field label={t("analysis.builderValueColumn")}><SelectInput value={configString(config, "column")} onChange={(event) => patch({ column: event.target.value })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
        <Field label={t("analysis.builderOffset")}><TextInput type="number" min={1} max={1_000} value={configNumber(config, "offset", 1)} onChange={(event) => patch({ offset: event.target.valueAsNumber })} /></Field>
        <Field label={t("analysis.builderPartitionBy")}><TextInput value={configStrings(config, "partitionBy").join(", ")} onChange={(event) => patch({ partitionBy: csv(event.target.value) })} /></Field>
        <Field label={t("analysis.builderOrderBy")}><SelectInput value={configString(config, "orderBy")} onChange={(event) => patch({ orderBy: event.target.value })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
        <Field label={t("analysis.builderOutputColumn")}><TextInput value={configString(config, "as")} onChange={(event) => patch({ as: event.target.value })} /></Field>
      </FormGrid>
    );
  }
  if (["ratio", "difference", "rate"].includes(transform.operation)) {
    return (
      <FormGrid>
        <Field label={t("analysis.builderNumerator")}><SelectInput value={configString(config, "numerator")} onChange={(event) => patch({ numerator: event.target.value })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
        <Field label={t("analysis.builderDenominator")}><SelectInput value={configString(config, "denominator")} onChange={(event) => patch({ denominator: event.target.value })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
        <Field label={t("analysis.builderOutputColumn")}><TextInput value={configString(config, "as")} onChange={(event) => patch({ as: event.target.value })} /></Field>
      </FormGrid>
    );
  }
  if (transform.operation === "cohort") {
    return (
      <FormGrid>
        <Field label={t("analysis.builderEntityColumn")}><SelectInput value={configString(config, "entityColumn")} onChange={(event) => patch({ entityColumn: event.target.value })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
        <Field label={t("analysis.builderEventTime")}><SelectInput value={configString(config, "eventTimeColumn")} onChange={(event) => patch({ eventTimeColumn: event.target.value })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
        <Field label={t("analysis.builderCohortUnit")}><SelectInput value={configString(config, "cohortUnit")} onChange={(event) => patch({ cohortUnit: event.target.value })}>{["day", "week", "month"].map((value) => <option value={value} key={value}>{value}</option>)}</SelectInput></Field>
        <Field label={t("analysis.builderOutputColumn")}><TextInput value={configString(config, "as")} onChange={(event) => patch({ as: event.target.value })} /></Field>
      </FormGrid>
    );
  }
  return (
    <FormGrid>
      <Field label={t("analysis.builderEntityColumn")}><SelectInput value={configString(config, "entityColumn")} onChange={(event) => patch({ entityColumn: event.target.value })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
      <Field label={t("analysis.builderCohortColumn")}><SelectInput value={configString(config, "cohortColumn")} onChange={(event) => patch({ cohortColumn: event.target.value })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
      <Field label={t("analysis.builderEventTime")}><SelectInput value={configString(config, "eventTimeColumn")} onChange={(event) => patch({ eventTimeColumn: event.target.value })}>{first.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
      <Field label={t("analysis.builderPeriodUnit")}><SelectInput value={configString(config, "periodUnit")} onChange={(event) => patch({ periodUnit: event.target.value })}>{["day", "week", "month"].map((value) => <option value={value} key={value}>{value}</option>)}</SelectInput></Field>
      <Field label={t("analysis.builderPeriods")}><TextInput type="number" min={1} max={365} value={configNumber(config, "periods", 12)} onChange={(event) => patch({ periods: event.target.valueAsNumber })} /></Field>
      <Field label={t("analysis.builderOutputColumn")}><TextInput value={configString(config, "as")} onChange={(event) => patch({ as: event.target.value })} /></Field>
    </FormGrid>
  );
}

export function AnalysisTransformEditor({
  definition,
  onChange,
}: {
  definition: AnalysisArticleDefinition;
  onChange: (definition: AnalysisArticleDefinition) => void;
}) {
  const { t } = useI18n();
  const [newOperation, setNewOperation] = useState<AnalysisTransformOperation>("filter");
  const allNodes = availableNodes(definition);
  const addTransform = () => {
    const binary = ["inner_join", "left_join", "union"].includes(newOperation);
    if (allNodes.length < (binary ? 2 : 1)) return;
    const inputNodes = binary ? allNodes.slice(-2) : allNodes.slice(-1);
    const id = uniqueIdentifier(newOperation, "transform", allNodes.map((node) => node.id));
    const config = defaultTransformConfig(newOperation, inputNodes);
    const transform: AnalysisTransformNode = {
      id,
      title: humanize(newOperation),
      operation: newOperation,
      inputNodeIds: inputNodes.map((node) => node.id),
      config,
      columns: [],
    };
    transform.columns = deriveTransformColumns(transform, allNodes);
    onChange({ ...definition, transforms: [...definition.transforms, transform] });
  };
  const patchTransform = (
    index: number,
    patch: Partial<AnalysisTransformNode>,
    derive = false,
  ) => {
    const current = definition.transforms[index]!;
    const next = { ...current, ...patch };
    const nodes = availableNodes(definition, index);
    if (derive) next.columns = deriveTransformColumns(next, nodes);
    onChange({ ...definition, transforms: replaceAt(definition.transforms, index, next) });
  };
  return (
    <div className="tw:grid tw:gap-4">
      <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
        <SelectInput density="compact" aria-label={t("analysis.builderNewTransformOperation")} value={newOperation} onChange={(event) => setNewOperation(event.target.value as AnalysisTransformOperation)}>
          {analysisTransformOperations.map((operation) => <option value={operation} key={operation}>{humanize(operation)}</option>)}
        </SelectInput>
        <Button size="compact" disabled={allNodes.length < (["inner_join", "left_join", "union"].includes(newOperation) ? 2 : 1)} onClick={addTransform}><Icon name="plus" /> {t("analysis.builderAddTransform")}</Button>
      </div>
      {definition.transforms.length === 0 ? <EmptyBuilder>{t("analysis.builderTransformEmpty")}</EmptyBuilder> : (
        <div className="tw:grid tw:gap-3">
          {definition.transforms.map((transform, index) => {
            const nodes = availableNodes(definition, index);
            const binary = ["inner_join", "left_join", "union"].includes(transform.operation);
            const inputOptions = transform.inputNodeIds.map((id) => nodes.find((node) => node.id === id)).filter((node): node is NodeOption => Boolean(node));
            const duplicateColumns = new Set<string>();
            transform.columns.forEach((column, columnIndex) => {
              if (transform.columns.findIndex((candidate) => candidate.name === column.name) !== columnIndex) duplicateColumns.add(column.name);
            });
            const movedUp = move(definition.transforms, index, -1);
            const movedDown = move(definition.transforms, index, 1);
            return (
              <BuilderCard
                key={`${index}:${transform.id}`}
                title={transform.title || transform.id}
                metadata={`${humanize(transform.operation)} · ${transform.inputNodeIds.join(" + ")} → ${t("analysis.builderColumnsCount", { count: transform.columns.length })}`}
                index={index}
                count={definition.transforms.length}
                moveUpDisabled={!transformOrderValid(definition, movedUp)}
                moveDownDisabled={!transformOrderValid(definition, movedDown)}
                removeDisabled={nodeReferenced(definition, transform.id)}
                removeDisabledReason={t("analysis.builderTransformRemoveBlocked")}
                onMove={(direction) => onChange({ ...definition, transforms: move(definition.transforms, index, direction) })}
                onRemove={() => onChange({ ...definition, transforms: removeAt(definition.transforms, index) })}
              >
                <FormGrid>
                  <Field label={t("analysis.builderNodeId")} validation={!IDENTIFIER.test(transform.id) ? { tone: "danger", message: t("analysis.builderInvalidNodeId") } : undefined}><TextInput value={transform.id} onChange={(event) => onChange(renameNode(definition, transform.id, event.target.value))} /></Field>
                  <Field label={t("analysis.fieldTitle")}><TextInput value={transform.title} onChange={(event) => patchTransform(index, { title: event.target.value })} /></Field>
                  <Field label={t("analysis.builderOperation")}>
                    <SelectInput value={transform.operation} onChange={(event) => {
                      const operation = event.target.value as AnalysisTransformOperation;
                      const needsTwo = ["inner_join", "left_join", "union"].includes(operation);
                      const inputs = needsTwo ? nodes.slice(-2) : nodes.slice(-1);
                      const config = defaultTransformConfig(operation, inputs);
                      patchTransform(index, { operation, inputNodeIds: inputs.map((node) => node.id), config }, true);
                    }}>
                      {analysisTransformOperations.map((operation) => <option value={operation} key={operation}>{humanize(operation)}</option>)}
                    </SelectInput>
                  </Field>
                  {Array.from({ length: binary ? 2 : 1 }, (_, inputIndex) => (
                    <Field label={binary ? t("analysis.builderInputNumber", { number: inputIndex + 1 }) : t("analysis.builderInput")} key={inputIndex}>
                      <SelectInput value={transform.inputNodeIds[inputIndex] ?? ""} onChange={(event) => {
                        const inputNodeIds = transform.inputNodeIds.map((id, itemIndex) => itemIndex === inputIndex ? event.target.value : id);
                        patchTransform(index, { inputNodeIds }, true);
                      }}>
                        {nodes.map((node) => <option value={node.id} key={node.id}>{node.title} · {node.id}</option>)}
                      </SelectInput>
                    </Field>
                  ))}
                </FormGrid>
                <TransformConfigEditor transform={transform} inputs={inputOptions} onChange={(config) => patchTransform(index, { config }, true)} />
                {duplicateColumns.size ? <InlineNotice tone="danger" icon="alert">{t("analysis.builderDuplicateColumns", { columns: [...duplicateColumns].join(", ") })}</InlineNotice> : null}
                <ColumnEditor columns={transform.columns.length ? transform.columns : [defaultColumn()]} onChange={(columns) => patchTransform(index, { columns })} />
              </BuilderCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

const defaultNumberFormat: AnalysisNumberFormat = {
  style: "number",
  decimals: 0,
  currency: null,
};

function nodeColumns(definition: AnalysisArticleDefinition, nodeId: string): AnalysisColumn[] {
  return availableNodes(definition).find((node) => node.id === nodeId)?.columns ?? [];
}

function numericColumns(columns: readonly AnalysisColumn[]): AnalysisColumn[] {
  return columns.filter((column) => ["number", "duration", "currency", "percent"].includes(column.type));
}

function FormatEditor({
  format,
  onChange,
}: {
  format: AnalysisNumberFormat;
  onChange: (format: AnalysisNumberFormat) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="tw:grid tw:grid-cols-3 tw:gap-2 tw:@max-[640px]:grid-cols-1">
      <Field label={t("analysis.builderNumberStyle")}>
        <SelectInput value={format.style} onChange={(event) => {
          const style = event.target.value as AnalysisNumberFormat["style"];
          onChange({ ...format, style, currency: style === "currency" ? format.currency ?? "USD" : null });
        }}>
          {["number", "percent", "currency", "duration", "compact"].map((style) => <option value={style} key={style}>{style}</option>)}
        </SelectInput>
      </Field>
      <Field label={t("analysis.builderDecimals")}><TextInput type="number" min={0} max={8} value={format.decimals} onChange={(event) => onChange({ ...format, decimals: event.target.valueAsNumber })} /></Field>
      {format.style === "currency" ? <Field label={t("analysis.builderCurrency")}><TextInput value={format.currency ?? "USD"} maxLength={3} onChange={(event) => onChange({ ...format, currency: event.target.value.toUpperCase() })} /></Field> : null}
    </div>
  );
}

function defaultMetric(definition: AnalysisArticleDefinition): AnalysisMetric | null {
  const node = availableNodes(definition).find((candidate) => numericColumns(candidate.columns).length > 0);
  const column = node && numericColumns(node.columns)[0];
  if (!node || !column) return null;
  const id = uniqueIdentifier(column.name, "metric", definition.metrics.map((metric) => metric.id));
  return {
    id,
    label: humanize(column.name),
    description: "",
    sourceNodeId: node.id,
    valueColumn: column.name,
    unit: "",
    lowerIsBetter: null,
    format: { ...defaultNumberFormat },
  };
}

function blockNeedsSource(kind: AnalysisBlockKind): boolean {
  return ["metric", "time_series", "bar", "area", "scatter", "table", "funnel", "retention_cohort", "heatmap"].includes(kind);
}

function defaultBlock(
  definition: AnalysisArticleDefinition,
  kind: AnalysisBlockKind,
  preferredNodeId?: string,
): AnalysisBlock | null {
  const nodes = availableNodes(definition);
  const node = nodes.find((candidate) => candidate.id === preferredNodeId) ?? nodes[0] ?? null;
  const first = node?.columns[0]?.name ?? "value";
  const numbers = node ? numericColumns(node.columns).map((column) => column.name) : [];
  const time = node?.columns.find((column) => column.role === "time")?.name ?? first;
  const dimension = node?.columns.find((column) => column.role === "dimension")?.name ?? first;
  const id = uniqueIdentifier(kind, "block", definition.blocks.map((block) => block.id));
  if (blockNeedsSource(kind) && !node) return null;
  if (kind === "metric") {
    const metric = definition.metrics[0];
    if (!metric) return null;
    return { id, kind, title: metric.label, sourceNodeId: metric.sourceNodeId, width: 4, config: { metricId: metric.id, comparisonColumn: null, sparklineColumn: null, sampleCountColumn: null } };
  }
  if (kind === "heading") return { id, kind, title: "", sourceNodeId: null, width: 12, config: { level: 2, text: "Section heading" } };
  if (kind === "markdown") return { id, kind, title: "", sourceNodeId: null, width: 12, config: { markdown: "Write the analysis context and interpretation." } };
  if (kind === "callout") return { id, kind, title: "", sourceNodeId: null, width: 12, config: { tone: "info", markdown: "Important context for this result." } };
  if (kind === "divider") return { id, kind, title: "", sourceNodeId: null, width: 12, config: {} };
  if (["time_series", "bar", "area", "scatter"].includes(kind)) return { id, kind, title: humanize(kind), sourceNodeId: node!.id, width: 8, config: { xColumn: time, yColumns: [numbers[0] ?? first], seriesColumn: null, stacked: false, format: { ...defaultNumberFormat } } };
  if (kind === "table") return { id, kind, title: "Table", sourceNodeId: node!.id, width: 12, config: { columns: node!.columns.slice(0, 12).map((column) => column.name), pageSize: 50 } };
  if (kind === "funnel") return { id, kind, title: "Funnel", sourceNodeId: node!.id, width: 8, config: { stageColumn: dimension, valueColumn: numbers[0] ?? first, rateColumn: numbers[1] ?? null, format: { ...defaultNumberFormat } } };
  if (kind === "retention_cohort") return { id, kind, title: "Retention cohort", sourceNodeId: node!.id, width: 12, config: { cohortColumn: dimension, periodColumn: time, valueColumn: numbers[0] ?? first, format: { style: "percent", decimals: 1, currency: null } } };
  if (kind === "heatmap") return { id, kind, title: "Heatmap", sourceNodeId: node!.id, width: 12, config: { xColumn: time, yColumn: dimension, valueColumn: numbers[0] ?? first, format: { ...defaultNumberFormat } } };
  const required = kind === "date_range_control" ? 2 : 1;
  if (definition.parameters.length < required) return null;
  return { id, kind, title: humanize(kind), sourceNodeId: null, width: kind === "date_range_control" ? 6 : 4, config: { parameterIds: definition.parameters.slice(0, required).map((parameter) => parameter.id) } };
}

function BlockConfigEditor({
  definition,
  block,
  onChange,
}: {
  definition: AnalysisArticleDefinition;
  block: AnalysisBlock;
  onChange: (block: AnalysisBlock) => void;
}) {
  const { t } = useI18n();
  const config = block.config;
  const columns = block.sourceNodeId ? nodeColumns(definition, block.sourceNodeId) : [];
  const patch = (value: Record<string, unknown>) => onChange({ ...block, config: { ...config, ...value } });
  const format = (config.format && typeof config.format === "object" && !Array.isArray(config.format)
    ? config.format : defaultNumberFormat) as AnalysisNumberFormat;
  if (block.kind === "heading") return <FormGrid><Field label={t("analysis.builderHeadingLevel")}><SelectInput value={configNumber(config, "level", 2)} onChange={(event) => patch({ level: Number(event.target.value) })}><option value="1">H1</option><option value="2">H2</option><option value="3">H3</option></SelectInput></Field><Field label={t("analysis.builderText")}><TextInput value={configString(config, "text")} onChange={(event) => patch({ text: event.target.value })} /></Field></FormGrid>;
  if (block.kind === "markdown") return <Field label="Markdown"><TextAreaInput value={configString(config, "markdown")} onChange={(event) => patch({ markdown: event.target.value })} /></Field>;
  if (block.kind === "callout") return <div className="tw:grid tw:gap-3"><Field label={t("analysis.builderTone")}><SelectInput value={configString(config, "tone")} onChange={(event) => patch({ tone: event.target.value })}>{["info", "success", "warning", "danger"].map((tone) => <option value={tone} key={tone}>{tone}</option>)}</SelectInput></Field><Field label="Markdown"><TextAreaInput value={configString(config, "markdown")} onChange={(event) => patch({ markdown: event.target.value })} /></Field></div>;
  if (block.kind === "divider") return <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">{t("analysis.builderDividerBody")}</p>;
  if (block.kind === "metric") {
    return (
      <div className="tw:grid tw:gap-3">
        <Field label={t("analysis.builderMetric")}>
          <SelectInput value={configString(config, "metricId")} onChange={(event) => {
            const metric = definition.metrics.find((candidate) => candidate.id === event.target.value);
            if (metric) onChange({ ...block, sourceNodeId: metric.sourceNodeId, title: block.title || metric.label, config: { ...config, metricId: metric.id } });
          }}>
            {definition.metrics.map((metric) => <option value={metric.id} key={metric.id}>{metric.label} · {metric.id}</option>)}
          </SelectInput>
        </Field>
        <FormGrid>
          {(["comparisonColumn", "sparklineColumn", "sampleCountColumn"] as const).map((key) => <Field label={humanize(key)} key={key}><SelectInput value={configNullableString(config, key) ?? ""} onChange={(event) => patch({ [key]: event.target.value || null })}><option value="">{t("analysis.none")}</option>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>)}
        </FormGrid>
      </div>
    );
  }
  if (["time_series", "bar", "area", "scatter"].includes(block.kind)) {
    return (
      <div className="tw:grid tw:gap-3">
        <FormGrid>
          <Field label={t("analysis.builderXColumn")}><SelectInput value={configString(config, "xColumn")} onChange={(event) => patch({ xColumn: event.target.value })}>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
          <Field label={t("analysis.builderSeriesColumn")}><SelectInput value={configNullableString(config, "seriesColumn") ?? ""} onChange={(event) => patch({ seriesColumn: event.target.value || null })}><option value="">{t("analysis.none")}</option>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
        </FormGrid>
        <Field label={t("analysis.builderYColumns")}><ColumnChecklist columns={numericColumns(columns)} selected={configStrings(config, "yColumns")} onChange={(yColumns) => patch({ yColumns })} /></Field>
        <CheckboxField label={t("analysis.builderStackSeries")} checked={configBoolean(config, "stacked")} disabled={block.kind === "scatter"} onChange={(event) => patch({ stacked: event.target.checked })} />
        <FormatEditor format={format} onChange={(next) => patch({ format: next })} />
      </div>
    );
  }
  if (block.kind === "table") return <div className="tw:grid tw:gap-3"><Field label={t("analysis.builderVisibleColumns")}><ColumnChecklist columns={columns} selected={configStrings(config, "columns")} onChange={(selected) => patch({ columns: selected })} /></Field><Field label={t("analysis.builderRowsPerPage")}><TextInput type="number" min={10} max={500} value={configNumber(config, "pageSize", 50)} onChange={(event) => patch({ pageSize: event.target.valueAsNumber })} /></Field></div>;
  if (block.kind === "funnel") return <div className="tw:grid tw:gap-3"><FormGrid><Field label={t("analysis.builderStageColumn")}><SelectInput value={configString(config, "stageColumn")} onChange={(event) => patch({ stageColumn: event.target.value })}>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field><Field label={t("analysis.builderValueColumn")}><SelectInput value={configString(config, "valueColumn")} onChange={(event) => patch({ valueColumn: event.target.value })}>{numericColumns(columns).map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field><Field label={t("analysis.builderRateColumn")}><SelectInput value={configNullableString(config, "rateColumn") ?? ""} onChange={(event) => patch({ rateColumn: event.target.value || null })}><option value="">{t("analysis.none")}</option>{numericColumns(columns).map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field></FormGrid><FormatEditor format={format} onChange={(next) => patch({ format: next })} /></div>;
  if (block.kind === "retention_cohort") return <div className="tw:grid tw:gap-3"><FormGrid><Field label={t("analysis.builderCohortColumn")}><SelectInput value={configString(config, "cohortColumn")} onChange={(event) => patch({ cohortColumn: event.target.value })}>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field><Field label={t("analysis.builderPeriodColumn")}><SelectInput value={configString(config, "periodColumn")} onChange={(event) => patch({ periodColumn: event.target.value })}>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field><Field label={t("analysis.builderValueColumn")}><SelectInput value={configString(config, "valueColumn")} onChange={(event) => patch({ valueColumn: event.target.value })}>{numericColumns(columns).map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field></FormGrid><FormatEditor format={format} onChange={(next) => patch({ format: next })} /></div>;
  if (block.kind === "heatmap") return <div className="tw:grid tw:gap-3"><FormGrid><Field label={t("analysis.builderXColumn")}><SelectInput value={configString(config, "xColumn")} onChange={(event) => patch({ xColumn: event.target.value })}>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field><Field label={t("analysis.builderYColumn")}><SelectInput value={configString(config, "yColumn")} onChange={(event) => patch({ yColumn: event.target.value })}>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field><Field label={t("analysis.builderValueColumn")}><SelectInput value={configString(config, "valueColumn")} onChange={(event) => patch({ valueColumn: event.target.value })}>{numericColumns(columns).map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field></FormGrid><FormatEditor format={format} onChange={(next) => patch({ format: next })} /></div>;
  const required = block.kind === "date_range_control" ? 2 : 1;
  const selected = configStrings(config, "parameterIds");
  return <Field label={t("analysis.builderSelectParameters", { count: required })}><ColumnChecklist columns={definition.parameters.map((parameter) => ({ ...defaultColumn(parameter.id), name: parameter.id }))} selected={selected} onChange={(parameterIds) => patch({ parameterIds: parameterIds.slice(0, required) })} /></Field>;
}

export function AnalysisLayoutEditor({
  definition,
  onChange,
}: {
  definition: AnalysisArticleDefinition;
  onChange: (definition: AnalysisArticleDefinition) => void;
}) {
  const { t } = useI18n();
  const [newBlockKind, setNewBlockKind] = useState<AnalysisBlockKind>("metric");
  const nodes = useMemo(() => availableNodes(definition), [definition.queries, definition.transforms]);
  const addMetric = () => {
    const metric = defaultMetric(definition);
    if (metric) onChange({ ...definition, metrics: [...definition.metrics, metric] });
  };
  const addBlock = () => {
    const block = defaultBlock(definition, newBlockKind);
    if (block) onChange({ ...definition, blocks: [...definition.blocks, block] });
  };
  return (
    <div className="tw:grid tw:gap-7">
      <Section title={t("analysis.builderSemanticMetrics")} description={t("analysis.builderSemanticMetricsBody")} action={<Button size="compact" disabled={!defaultMetric(definition)} onClick={addMetric}><Icon name="plus" /> {t("analysis.builderAddMetric")}</Button>}>
        {definition.metrics.length === 0 ? <EmptyBuilder>{t("analysis.builderMetricsEmpty")}</EmptyBuilder> : <div className="tw:grid tw:gap-3">{definition.metrics.map((metric, index) => {
          const columns = numericColumns(nodeColumns(definition, metric.sourceNodeId));
          return <BuilderCard key={`${index}:${metric.id}`} title={metric.label || metric.id} metadata={`${metric.id} · ${metric.sourceNodeId}.${metric.valueColumn}`} index={index} count={definition.metrics.length} removeDisabled={metricReferenced(definition, metric.id)} removeDisabledReason={t("analysis.builderMetricRemoveBlocked")} onMove={(direction) => onChange({ ...definition, metrics: move(definition.metrics, index, direction) })} onRemove={() => onChange({ ...definition, metrics: removeAt(definition.metrics, index) })}>
            <FormGrid>
              <Field label={t("analysis.builderMetricId")} validation={!IDENTIFIER.test(metric.id) ? { tone: "danger", message: t("analysis.builderInvalidMetricId") } : undefined}><TextInput value={metric.id} onChange={(event) => onChange(renameMetric(definition, metric.id, event.target.value))} /></Field>
              <Field label={t("analysis.builderLabel")}><TextInput value={metric.label} onChange={(event) => onChange({ ...definition, metrics: replaceAt(definition.metrics, index, { ...metric, label: event.target.value }) })} /></Field>
              <Field label={t("analysis.builderSourceNode")}><SelectInput value={metric.sourceNodeId} onChange={(event) => {
                const sourceNodeId = event.target.value;
                const valueColumn = numericColumns(nodeColumns(definition, sourceNodeId))[0]?.name ?? "";
                onChange({ ...definition, metrics: replaceAt(definition.metrics, index, { ...metric, sourceNodeId, valueColumn }) });
              }}>{nodes.filter((node) => numericColumns(node.columns).length).map((node) => <option value={node.id} key={node.id}>{node.title} · {node.id}</option>)}</SelectInput></Field>
              <Field label={t("analysis.builderValueColumn")}><SelectInput value={metric.valueColumn} onChange={(event) => onChange({ ...definition, metrics: replaceAt(definition.metrics, index, { ...metric, valueColumn: event.target.value }) })}>{columns.map((column) => <option value={column.name} key={column.name}>{column.name}</option>)}</SelectInput></Field>
              <Field label={t("analysis.builderUnit")}><TextInput value={metric.unit} onChange={(event) => onChange({ ...definition, metrics: replaceAt(definition.metrics, index, { ...metric, unit: event.target.value }) })} /></Field>
              <Field label={t("analysis.builderGoalDirection")}><SelectInput value={metric.lowerIsBetter === null ? "neutral" : metric.lowerIsBetter ? "lower" : "higher"} onChange={(event) => onChange({ ...definition, metrics: replaceAt(definition.metrics, index, { ...metric, lowerIsBetter: event.target.value === "neutral" ? null : event.target.value === "lower" }) })}><option value="neutral">{t("analysis.builderNeutral")}</option><option value="higher">{t("analysis.builderHigherBetter")}</option><option value="lower">{t("analysis.builderLowerBetter")}</option></SelectInput></Field>
            </FormGrid>
            <Field label={t("analysis.publicationDescription")}><TextAreaInput value={metric.description} onChange={(event) => onChange({ ...definition, metrics: replaceAt(definition.metrics, index, { ...metric, description: event.target.value }) })} /></Field>
            <FormatEditor format={metric.format} onChange={(format) => onChange({ ...definition, metrics: replaceAt(definition.metrics, index, { ...metric, format }) })} />
          </BuilderCard>;
        })}</div>}
      </Section>

      <Section title={t("analysis.builderArticleBlocks")} description={t("analysis.builderArticleBlocksBody")} action={<div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2"><SelectInput density="compact" value={newBlockKind} onChange={(event) => setNewBlockKind(event.target.value as AnalysisBlockKind)}>{analysisBlockKinds.map((kind) => <option value={kind} key={kind}>{humanize(kind)}</option>)}</SelectInput><Button size="compact" disabled={!defaultBlock(definition, newBlockKind)} onClick={addBlock}><Icon name="plus" /> {t("analysis.builderAddBlock")}</Button></div>}>
        <div className="tw:grid tw:grid-cols-12 tw:gap-2 tw:rounded-md tw:border tw:border-dashed tw:border-border-subtle tw:bg-muted/30 tw:p-3" aria-label={t("analysis.builderLayoutPreview")}>
          {definition.blocks.map((block) => <div className="tw:min-w-0 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:px-2 tw:py-3" style={{ gridColumn: `span ${Math.max(1, Math.min(12, block.width))}` }} key={block.id}><strong className="tw:block tw:truncate tw:text-xs">{block.title || humanize(block.kind)}</strong><small className="tw:block tw:truncate tw:font-mono tw:text-2xs tw:text-muted-foreground">{humanize(block.kind)} · {block.width}/12</small></div>)}
        </div>
        <div className="tw:grid tw:gap-3">{definition.blocks.map((block, index) => <BuilderCard key={`${index}:${block.id}`} title={block.title || humanize(block.kind)} metadata={`${block.id} · ${humanize(block.kind)} · ${block.width}/12`} index={index} count={definition.blocks.length} removeDisabled={definition.blocks.length === 1 || blockReferenced(definition, block.id)} removeDisabledReason={definition.blocks.length === 1 ? t("analysis.builderBlockRequired") : t("analysis.builderBlockRemoveBlocked")} onMove={(direction) => onChange({ ...definition, blocks: move(definition.blocks, index, direction) })} onRemove={() => onChange({ ...definition, blocks: removeAt(definition.blocks, index) })}>
          <FormGrid>
            <Field label={t("analysis.builderBlockId")} validation={!IDENTIFIER.test(block.id) ? { tone: "danger", message: t("analysis.builderInvalidBlockId") } : undefined}><TextInput value={block.id} onChange={(event) => onChange(renameBlock(definition, block.id, event.target.value))} /></Field>
            <Field label={t("analysis.fieldTitle")}><TextInput value={block.title} onChange={(event) => onChange({ ...definition, blocks: replaceAt(definition.blocks, index, { ...block, title: event.target.value }) })} /></Field>
            <Field label={t("analysis.builderWidth")}><TextInput type="number" min={1} max={12} value={block.width} onChange={(event) => onChange({ ...definition, blocks: replaceAt(definition.blocks, index, { ...block, width: event.target.valueAsNumber }) })} /></Field>
            {blockNeedsSource(block.kind) && block.kind !== "metric" ? <Field label={t("analysis.builderSourceNode")}><SelectInput value={block.sourceNodeId ?? ""} onChange={(event) => {
              const sourceNodeId = event.target.value;
              const base = defaultBlock(
                { ...definition, blocks: definition.blocks.filter((candidate) => candidate.id !== block.id) },
                block.kind,
                sourceNodeId,
              );
              onChange({ ...definition, blocks: replaceAt(definition.blocks, index, { ...(base ?? block), id: block.id, title: block.title, width: block.width, sourceNodeId }) });
            }}>{nodes.map((node) => <option value={node.id} key={node.id}>{node.title} · {node.id}</option>)}</SelectInput></Field> : null}
          </FormGrid>
          <BlockConfigEditor definition={definition} block={block} onChange={(next) => onChange({ ...definition, blocks: replaceAt(definition.blocks, index, next) })} />
        </BuilderCard>)}</div>
      </Section>

      <EvidenceEditor definition={definition} onChange={onChange} />
    </div>
  );
}

function EvidenceEditor({ definition, onChange }: { definition: AnalysisArticleDefinition; onChange: (definition: AnalysisArticleDefinition) => void }) {
  const { t } = useI18n();
  const nodes = availableNodes(definition);
  const addClaim = () => {
    const id = uniqueIdentifier("claim", "claim", definition.claims.map((claim) => claim.id));
    const blockId = definition.blocks[0]?.id;
    const nodeId = nodes[0]?.id;
    if (!blockId && !nodeId) return;
    onChange({ ...definition, claims: [...definition.claims, { id, text: "Evidence-backed observation", blockIds: blockId ? [blockId] : [], nodeIds: nodeId ? [nodeId] : [] }] });
  };
  return (
    <Section title={t("analysis.builderReviewEvidence")} description={t("analysis.builderReviewEvidenceBody")} action={<Button size="compact" disabled={!definition.blocks.length && !nodes.length} onClick={addClaim}><Icon name="plus" /> {t("analysis.builderAddClaim")}</Button>}>
      {definition.claims.length === 0 ? (
        <EmptyBuilder>{t("analysis.builderClaimsEmpty")}</EmptyBuilder>
      ) : (
        <div className="tw:grid tw:gap-3">
          {definition.claims.map((claim, index) => (
            <BuilderCard
              key={`${index}:${claim.id}`}
              title={claim.text || claim.id}
              metadata={`${claim.id} · ${claim.blockIds.length} blocks · ${claim.nodeIds.length} nodes`}
              index={index}
              count={definition.claims.length}
              onMove={(direction) => onChange({ ...definition, claims: move(definition.claims, index, direction) })}
              onRemove={() => onChange({ ...definition, claims: removeAt(definition.claims, index) })}
            >
              <Field label={t("analysis.builderClaimId")}>
                <TextInput value={claim.id} onChange={(event) => onChange({
                  ...definition,
                  claims: replaceAt(definition.claims, index, { ...claim, id: event.target.value }),
                })} />
              </Field>
              <Field label={t("analysis.builderClaim")}>
                <TextAreaInput value={claim.text} onChange={(event) => onChange({
                  ...definition,
                  claims: replaceAt(definition.claims, index, { ...claim, text: event.target.value }),
                })} />
              </Field>
              <Field label={t("analysis.builderEvidenceBlocks")}>
                <div className="tw:flex tw:flex-wrap tw:gap-x-4 tw:gap-y-2">
                  {definition.blocks.map((block) => (
                    <CheckboxField
                      key={block.id}
                      label={block.title || block.id}
                      checked={claim.blockIds.includes(block.id)}
                      onChange={(event) => onChange({
                        ...definition,
                        claims: replaceAt(definition.claims, index, {
                          ...claim,
                          blockIds: event.target.checked
                            ? [...claim.blockIds, block.id]
                            : claim.blockIds.filter((id) => id !== block.id),
                        }),
                      })}
                    />
                  ))}
                </div>
              </Field>
              <Field label={t("analysis.builderEvidenceNodes")}>
                <div className="tw:flex tw:flex-wrap tw:gap-x-4 tw:gap-y-2">
                  {nodes.map((node) => (
                    <CheckboxField
                      key={node.id}
                      label={node.title || node.id}
                      checked={claim.nodeIds.includes(node.id)}
                      onChange={(event) => onChange({
                        ...definition,
                        claims: replaceAt(definition.claims, index, {
                          ...claim,
                          nodeIds: event.target.checked
                            ? [...claim.nodeIds, node.id]
                            : claim.nodeIds.filter((id) => id !== node.id),
                        }),
                      })}
                    />
                  ))}
                </div>
              </Field>
            </BuilderCard>
          ))}
        </div>
      )}
      <div className="tw:grid tw:gap-2">
        <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-2"><strong className="tw:text-xs">{t("analysis.builderReviewWarnings")}</strong><Button size="compact" onClick={() => onChange({ ...definition, warnings: [...definition.warnings, t("analysis.builderReviewRequired")] })}><Icon name="plus" /> {t("analysis.builderAddWarning")}</Button></div>
        {definition.warnings.map((warning, index) => <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:gap-2" key={index}><TextInput value={warning} onChange={(event) => onChange({ ...definition, warnings: replaceAt(definition.warnings, index, event.target.value) })} /><Button iconOnly variant="dangerGhost" aria-label={t("analysis.builderRemoveWarning")} onClick={() => onChange({ ...definition, warnings: removeAt(definition.warnings, index) })}><Icon name="trash" /></Button></div>)}
      </div>
    </Section>
  );
}
