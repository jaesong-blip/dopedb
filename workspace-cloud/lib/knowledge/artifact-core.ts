// Runtime-neutral structural validator for the GitHub code-index artifact
// stored by the Next.js control plane. It deliberately accepts only
// deterministic, provenance-backed extraction.

import { createHash } from "node:crypto";

import { canonicalKnowledgeJson } from "./canonical-json";

const MAX_NODES = 200_000;
const MAX_EDGES = 600_000;
const MAX_EVIDENCE = 600_000;
const MAX_CHANGED_FILES = 100_000;
const MAX_STRING_BYTES = 16 * 1024;
// Keep this wire limit synchronized with
// dopedb-protocol::MAX_KNOWLEDGE_GRAPH_ARTIFACT_BYTES. Desktop reserves the
// remaining 8 MiB of its 128 MiB response cap for the authenticated envelope.
export const MAX_KNOWLEDGE_GRAPH_ARTIFACT_BYTES = 120 * 1024 * 1024;

export function knowledgeGraphArtifactSizeAllowed(serializedBytes: number) {
  return Number.isSafeInteger(serializedBytes)
    && serializedBytes >= 0
    && serializedBytes <= MAX_KNOWLEDGE_GRAPH_ARTIFACT_BYTES;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function text(value: unknown, allowSlash = true): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    && (allowSlash || !value.includes("/"));
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha1(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function uuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function positiveU32(value: unknown): value is number {
  return positiveInteger(value) && value <= 0xffff_ffff;
}

function safeVersion(value: unknown): value is string {
  return text(value) && /^\d+\.\d+\.\d+$/.test(value);
}

function rfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offset] = match;
  const components = [year, month, day, hour, minute, second].map(Number);
  if (components.some((component) => !Number.isInteger(component))) return false;
  const [numericYear, numericMonth, numericDay, numericHour, numericMinute, numericSecond] = components;
  const leapYear = numericYear! % 4 === 0
    && (numericYear! % 100 !== 0 || numericYear! % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const calendarValid = numericMonth! >= 1
    && numericMonth! <= 12
    && numericDay! >= 1
    && numericDay! <= daysInMonth[numericMonth! - 1]!;
  const offsetValid = offset === "Z" || (() => {
    const [offsetHour, offsetMinute] = offset!.slice(1).split(":").map(Number);
    return offsetHour! <= 23 && offsetMinute! <= 59;
  })();
  if (!calendarValid || numericHour! > 23 || numericMinute! > 59 || numericSecond! > 59
    || !offsetValid) {
    return false;
  }
  return true;
}

function safeSlug(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 255
    && /^[A-Za-z0-9_.-]+$/.test(value);
}

function safePath(value: unknown): value is string {
  return text(value)
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function safeRef(value: unknown): value is string {
  return text(value)
    && !value.startsWith("/")
    && !value.startsWith(".")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && !/[\\~^:?*[\]]/.test(value);
}

function uniqueStrings(values: unknown, max: number, predicate: (value: unknown) => boolean) {
  if (!Array.isArray(values) || values.length > max) return false;
  const seen = new Set<string>();
  for (const value of values) {
    if (!predicate(value) || seen.has(value as string)) return false;
    seen.add(value as string);
  }
  return true;
}

function validRevision(value: unknown) {
  if (!object(value) || typeof value.kind !== "string") return false;
  if (value.kind === "github") {
    const repository = typeof value.repository === "string"
      ? value.repository.split("/")
      : [];
    return exactKeys(value, ["kind", "repository_id", "repository", "ref_name", "commit_sha"])
      && text(value.repository_id)
      && repository.length === 2
      && repository.every(safeSlug)
      && safeRef(value.ref_name)
      && sha1(value.commit_sha);
  }
  return false;
}

function validBinding(value: unknown) {
  if (
    !object(value)
    || !exactKeys(value, [
      "sourceId", "projectId", "projectEnvironmentId", "provider",
      "displayName", "visibility", "revision",
    ])
    || !uuid(value.sourceId)
    || !uuid(value.projectId)
    || !uuid(value.projectEnvironmentId)
    || value.provider !== "github"
    || !text(value.displayName)
    || value.visibility !== "shared_graph"
    || !validRevision(value.revision)
  ) {
    return false;
  }
  return true;
}

const NODE_KINDS = new Set([
  "file", "module", "type", "function", "route", "table", "column", "migration", "event",
]);
const RELATIONS = new Set([
  "defines", "imports", "calls", "handles_route", "reads_table", "writes_table",
  "emits_event", "migration_defines_table", "migration_defines_column",
]);
const EVIDENCE_STATES = new Set(["EXTRACTED", "VERIFIED", "AMBIGUOUS"]);

export type ValidGraphArtifact = JsonObject & {
  graphRevisionId: string;
  environmentRevision: number;
  parentGraphRevisionId: string | null;
  sourceRevisionSha256: string;
  generatedAt: string;
  binding: JsonObject & {
    sourceId: string;
    projectId: string;
    projectEnvironmentId: string;
    provider: "github";
    revision: JsonObject;
  };
};

export function validateGraphBuildArtifact(value: unknown): {
  artifact: ValidGraphArtifact;
  artifactSha256: string;
} | null {
  if (
    !object(value)
    || !exactKeys(value, [
      "schemaVersion", "graphRevisionId", "environmentRevision", "binding",
      "sourceRevisionSha256", "parentGraphRevisionId", "extractor", "generatedAt",
      "health", "changedFiles", "nodes", "edges", "evidence",
    ])
    || value.schemaVersion !== 1
    || !uuid(value.graphRevisionId)
    || !positiveInteger(value.environmentRevision)
    || !validBinding(value.binding)
    || !sha256(value.sourceRevisionSha256)
    || (value.parentGraphRevisionId !== null && !uuid(value.parentGraphRevisionId))
    || !rfc3339(value.generatedAt)
    || !object(value.extractor)
    || !exactKeys(value.extractor, ["id", "version", "sourceSha256"])
    || !text(value.extractor.id)
    || !safeVersion(value.extractor.version)
    || !sha256(value.extractor.sourceSha256)
    || !object(value.health)
    || !exactKeys(value.health, ["complete", "parsedFiles", "skippedFiles", "failedFiles"])
    || value.health.complete !== true
    || !Number.isSafeInteger(value.health.parsedFiles)
    || (value.health.parsedFiles as number) < 0
    || !Number.isSafeInteger(value.health.skippedFiles)
    || (value.health.skippedFiles as number) < 0
    || value.health.failedFiles !== 0
    || !uniqueStrings(value.changedFiles, MAX_CHANGED_FILES, safePath)
    || !Array.isArray(value.nodes)
    || value.nodes.length > MAX_NODES
    || !Array.isArray(value.edges)
    || value.edges.length > MAX_EDGES
    || !Array.isArray(value.evidence)
    || value.evidence.length > MAX_EVIDENCE
  ) {
    return null;
  }

  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (
      !object(node)
      || ![4, 5].includes(Object.keys(node).length)
      || !exactKeys(node, node.attributes === undefined
        ? ["id", "kind", "name", "qualifiedName"]
        : ["id", "kind", "name", "qualifiedName", "attributes"])
      || !sha256(node.id)
      || nodeIds.has(node.id)
      || typeof node.kind !== "string"
      || !NODE_KINDS.has(node.kind)
      || !text(node.name)
      || !text(node.qualifiedName)
      || (node.attributes !== undefined && (
        !object(node.attributes)
        || Object.keys(node.attributes).length > 64
        || !Object.entries(node.attributes).every(([key, attribute]) => text(key) && text(attribute))
      ))
    ) return null;
    nodeIds.add(node.id);
  }

  const binding = value.binding as ValidGraphArtifact["binding"];
  const evidenceIds = new Set<string>();
  for (const evidence of value.evidence) {
    if (
      !object(evidence)
      || !exactKeys(evidence, [
        "id", "sourceId", "sourceRevisionSha256", "filePath", "lineStart",
        "lineEnd", "extractionMethod", "observedAt",
      ])
      || !sha256(evidence.id)
      || evidenceIds.has(evidence.id)
      || evidence.sourceId !== binding.sourceId
      || evidence.sourceRevisionSha256 !== value.sourceRevisionSha256
      || !safePath(evidence.filePath)
      || !positiveU32(evidence.lineStart)
      || !positiveU32(evidence.lineEnd)
      || evidence.lineEnd < evidence.lineStart
      || !text(evidence.extractionMethod)
      || !rfc3339(evidence.observedAt)
    ) return null;
    evidenceIds.add(evidence.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    if (
      !object(edge)
      || !exactKeys(edge, ["id", "from", "to", "relation", "state", "evidenceIds"])
      || !sha256(edge.id)
      || edgeIds.has(edge.id)
      || typeof edge.from !== "string"
      || !nodeIds.has(edge.from)
      || typeof edge.to !== "string"
      || !nodeIds.has(edge.to)
      || typeof edge.relation !== "string"
      || !RELATIONS.has(edge.relation)
      || typeof edge.state !== "string"
      || !EVIDENCE_STATES.has(edge.state)
      || !uniqueStrings(edge.evidenceIds, 64, sha256)
      || (edge.evidenceIds as string[]).length === 0
      || !(edge.evidenceIds as string[]).every((id) => evidenceIds.has(id))
    ) return null;
    edgeIds.add(edge.id);
  }

  const artifact = value as ValidGraphArtifact;
  const serialized = canonicalKnowledgeJson(artifact);
  if (!knowledgeGraphArtifactSizeAllowed(Buffer.byteLength(serialized, "utf8"))) {
    return null;
  }
  return {
    artifact,
    artifactSha256: createHash("sha256").update(serialized).digest("hex"),
  };
}
