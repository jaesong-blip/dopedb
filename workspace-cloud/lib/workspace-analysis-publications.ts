// Safe fixed-value public Analysis Article snapshots. This contract has no SQL,
// connection identity, query receipt, credential, private evidence id, or live
// refresh capability.
import {
  analysisBlockKinds,
  type AnalysisArticleDefinition,
  type AnalysisParameterValue,
  type AnalysisBlockKind,
} from "./workspace-analysis-articles";
import {
  parseAnalysisResultFragment,
  type AnalysisResultFragmentPayload,
} from "./workspace-analysis-runs";

export type AnalysisPublicationRequest = Readonly<{
  id: string;
  runId: string;
  slug: string;
  replacePublicationId: string | null;
  visibility: "unlisted" | "public";
  title: string;
  description: string;
  blockIds: readonly string[];
  parameterIds: readonly string[];
  searchIndexable: boolean;
  sensitivityConfirmed: boolean;
  productionConfirmed: boolean;
  previewHash: string | null;
}>;

export type AnalysisPublicSnapshot = Readonly<{
  version: 1;
  title: string;
  description: string;
  summary: string;
  timezone: string;
  dataAsOf: string;
  searchIndexable: boolean;
  parameters: readonly Readonly<{
    label: string;
    value: AnalysisParameterValue;
  }>[];
  blocks: readonly Readonly<{
    id: string;
    kind: AnalysisBlockKind;
    title: string;
    width: number;
    config: Readonly<Record<string, unknown>>;
    fragments: readonly AnalysisResultFragmentPayload[];
  }>[];
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{7,127}$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const UNSAFE_DISPLAY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(row, field))
    ? row : null;
}

function text(value: unknown, maximum: number, empty = false) {
  if (typeof value !== "string" || value.length > maximum || UNSAFE_DISPLAY.test(value)) return null;
  return empty || value.trim().length > 0 ? value : null;
}

export function parseAnalysisPublicationRequest(value: unknown): AnalysisPublicationRequest {
  const row = exactRecord(value, [
    "id", "runId", "slug", "replacePublicationId", "visibility", "title", "description", "blockIds",
    "parameterIds", "searchIndexable", "sensitivityConfirmed", "productionConfirmed",
    "previewHash",
  ]);
  const title = text(row?.title, 160);
  const description = text(row?.description, 2_000, true);
  if (!row || typeof row.id !== "string" || !UUID.test(row.id)
    || typeof row.runId !== "string" || !UUID.test(row.runId)
    || typeof row.slug !== "string" || !SLUG.test(row.slug)
    || !(row.replacePublicationId === null
      || (typeof row.replacePublicationId === "string" && UUID.test(row.replacePublicationId)))
    || !(row.visibility === "unlisted" || row.visibility === "public")
    || title === null || description === null || !Array.isArray(row.blockIds)
    || row.blockIds.length < 1 || row.blockIds.length > 128
    || row.blockIds.some((id) => typeof id !== "string" || !ID.test(id))
    || new Set(row.blockIds).size !== row.blockIds.length
    || !Array.isArray(row.parameterIds) || row.parameterIds.length > 32
    || row.parameterIds.some((id) => typeof id !== "string" || !ID.test(id))
    || new Set(row.parameterIds).size !== row.parameterIds.length
    || typeof row.searchIndexable !== "boolean"
    || (row.searchIndexable && row.visibility !== "public")
    || row.sensitivityConfirmed !== true || row.productionConfirmed !== true
    || !(row.previewHash === null
      || (typeof row.previewHash === "string" && HASH.test(row.previewHash)))) {
    throw new Error("Invalid Analysis Article publication request");
  }
  return {
    id: row.id,
    runId: row.runId,
    slug: row.slug,
    replacePublicationId: row.replacePublicationId as string | null,
    visibility: row.visibility,
    title,
    description,
    blockIds: row.blockIds as string[],
    parameterIds: row.parameterIds as string[],
    searchIndexable: row.searchIndexable,
    sensitivityConfirmed: true,
    productionConfirmed: true,
    previewHash: row.previewHash as string | null,
  };
}

function publicConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid public Analysis Article block config");
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > 100_000 || /"(?:sql|connectionId|queryRunId|sourceNodeId|credential|capability)"\s*:/u.test(encoded)) {
    throw new Error("Unsafe public Analysis Article block config");
  }
  return value as Readonly<Record<string, unknown>>;
}

export function buildAnalysisPublicSnapshot(input: {
  request: AnalysisPublicationRequest;
  definition: AnalysisArticleDefinition;
  parameterValues: Readonly<Record<string, AnalysisParameterValue>>;
  fragments: readonly AnalysisResultFragmentPayload[];
  dataAsOf: Date;
}): AnalysisPublicSnapshot {
  if (Number.isNaN(input.dataAsOf.valueOf())) throw new Error("Invalid publication data time");
  const byBlock = new Map<string, AnalysisResultFragmentPayload[]>();
  for (const fragment of input.fragments) {
    const values = byBlock.get(fragment.blockId) ?? [];
    values.push(fragment);
    byBlock.set(fragment.blockId, values);
  }
  const knownBlocks = new Set(input.definition.blocks.map((block) => block.id));
  const knownParameters = new Set(input.definition.parameters.map((parameter) => parameter.id));
  if (input.request.blockIds.some((id) => !knownBlocks.has(id))
    || input.request.parameterIds.some((id) => !knownParameters.has(id))) {
    throw new Error("Analysis publication selection is stale");
  }
  const selectedBlocks = new Set(input.request.blockIds);
  const selectedParameters = new Set(input.request.parameterIds);
  const interactiveBlockIds = new Set(
    input.definition.blocks
      .filter((block) => [
        "date_range_control",
        "comparison_control",
        "segment_control",
      ].includes(block.kind))
      .map((block) => block.id),
  );
  if (input.request.blockIds.some((id) => interactiveBlockIds.has(id))) {
    throw new Error("A fixed Analysis publication cannot contain interactive controls");
  }
  for (const fragment of input.fragments) {
    if (!selectedBlocks.has(fragment.blockId)) continue;
    if (fragment.columns.some((column) => column.sensitivity !== "public"
      && !["hash", "redact"].includes(column.masking))) {
      throw new Error("Analysis publication contains a private column without irreversible masking");
    }
  }
  return parseAnalysisPublicSnapshot({
    version: 1,
    title: input.request.title,
    description: input.request.description,
    summary: input.definition.summary,
    timezone: input.definition.timezone,
    dataAsOf: input.dataAsOf.toISOString(),
    searchIndexable: input.request.searchIndexable,
    parameters: input.definition.parameters.filter((parameter) => selectedParameters.has(parameter.id)).map((parameter) => ({
      label: parameter.label,
      value: input.parameterValues[parameter.id] ?? parameter.defaultValue,
    })),
    blocks: input.definition.blocks.filter((block) => selectedBlocks.has(block.id)).map((block) => {
      const metric = block.kind === "metric"
        ? input.definition.metrics.find((candidate) => candidate.id === block.config.metricId)
        : null;
      return {
        id: block.id,
        kind: block.kind,
        title: block.title,
        width: block.width,
        config: metric ? {
          ...block.config,
          publicMetric: {
            label: metric.label,
            description: metric.description,
            valueColumn: metric.valueColumn,
            unit: metric.unit,
            lowerIsBetter: metric.lowerIsBetter,
            format: metric.format,
          },
        } : block.config,
        fragments: (byBlock.get(block.id) ?? []).sort((left, right) => left.ordinal - right.ordinal),
      };
    }),
  });
}

export function parseAnalysisPublicSnapshot(value: unknown): AnalysisPublicSnapshot {
  const row = exactRecord(value, [
    "version", "title", "description", "summary", "timezone", "dataAsOf",
    "searchIndexable", "parameters", "blocks",
  ]);
  const title = text(row?.title, 160);
  const description = text(row?.description, 2_000, true);
  const summary = text(row?.summary, 20_000, true);
  const timezone = text(row?.timezone, 128);
  const dataAsOf = typeof row?.dataAsOf === "string" ? new Date(row.dataAsOf) : null;
  if (!row || row.version !== 1 || title === null || description === null || summary === null
    || timezone === null || !dataAsOf || Number.isNaN(dataAsOf.valueOf())
    || typeof row.searchIndexable !== "boolean"
    || !Array.isArray(row.parameters) || row.parameters.length > 32
    || !Array.isArray(row.blocks) || row.blocks.length < 1 || row.blocks.length > 128) {
    throw new Error("Invalid public Analysis Article snapshot");
  }
  const parameters = row.parameters.map((value) => {
    const parameter = exactRecord(value, ["label", "value"]);
    const label = text(parameter?.label, 128);
    const candidate = parameter?.value;
    if (!parameter || label === null || !(candidate === null || typeof candidate === "boolean"
      || (typeof candidate === "number" && Number.isFinite(candidate))
      || (typeof candidate === "string" && candidate.length <= 4_000 && !candidate.includes("\u0000")))) {
      throw new Error("Invalid public Analysis Article parameter");
    }
    return { label, value: candidate as AnalysisParameterValue };
  });
  const blocks = row.blocks.map((value) => {
    const block = exactRecord(value, ["id", "kind", "title", "width", "config", "fragments"]);
    const blockTitle = text(block?.title, 256, true);
    if (!block || typeof block.id !== "string" || !ID.test(block.id)
      || typeof block.kind !== "string" || !analysisBlockKinds.includes(block.kind as AnalysisBlockKind)
      || blockTitle === null || typeof block.width !== "number" || !Number.isSafeInteger(block.width)
      || block.width < 1 || block.width > 12 || !Array.isArray(block.fragments)
      || block.fragments.length > 256) throw new Error("Invalid public Analysis Article block");
    const fragments = block.fragments.map(parseAnalysisResultFragment);
    if (fragments.some((fragment) => fragment.blockId !== block.id)) {
      throw new Error("Invalid public Analysis Article fragment reference");
    }
    return {
      id: block.id,
      kind: block.kind as AnalysisBlockKind,
      title: blockTitle,
      width: block.width,
      config: publicConfig(block.config),
      fragments,
    };
  });
  if (new Set(blocks.map((block) => block.id)).size !== blocks.length) {
    throw new Error("Duplicate public Analysis Article block");
  }
  const snapshot = {
    version: 1 as const,
    title,
    description,
    summary,
    timezone,
    dataAsOf: dataAsOf.toISOString(),
    searchIndexable: row.searchIndexable,
    parameters,
    blocks,
  };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 16 * 1024 * 1024) {
    throw new Error("Public Analysis Article snapshot is too large");
  }
  return snapshot;
}
