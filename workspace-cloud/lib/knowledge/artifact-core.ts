// Runtime-neutral structural validator for the GitHub code-index artifact
// stored by the Next.js control plane. It deliberately accepts only
// deterministic, provenance-backed extraction.

import { createHash } from "node:crypto";

const MAX_NODES = 200_000;
const MAX_EDGES = 600_000;
const MAX_EVIDENCE = 600_000;
const MAX_STRING_BYTES = 16 * 1024;

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
    && !/[\u0000-\u001f\u007f]/.test(value)
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
    return exactKeys(value, ["kind", "repository_id", "repository", "ref_name", "commit_sha"])
      && text(value.repository_id)
      && typeof value.repository === "string"
      && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)
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
    || typeof value.generatedAt !== "string"
    || !Number.isFinite(Date.parse(value.generatedAt))
    || !object(value.extractor)
    || !exactKeys(value.extractor, ["id", "version", "sourceSha256"])
    || !text(value.extractor.id)
    || typeof value.extractor.version !== "string"
    || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(value.extractor.version)
    || !sha256(value.extractor.sourceSha256)
    || !object(value.health)
    || !exactKeys(value.health, ["complete", "parsedFiles", "skippedFiles", "failedFiles"])
    || value.health.complete !== true
    || !Number.isSafeInteger(value.health.parsedFiles)
    || (value.health.parsedFiles as number) < 0
    || !Number.isSafeInteger(value.health.skippedFiles)
    || (value.health.skippedFiles as number) < 0
    || value.health.failedFiles !== 0
    || !uniqueStrings(value.changedFiles, MAX_NODES, safePath)
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
      || !positiveInteger(evidence.lineStart)
      || !positiveInteger(evidence.lineEnd)
      || evidence.lineEnd < evidence.lineStart
      || !text(evidence.extractionMethod)
      || typeof evidence.observedAt !== "string"
      || !Number.isFinite(Date.parse(evidence.observedAt))
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
  return {
    artifact,
    artifactSha256: createHash("sha256").update(JSON.stringify(artifact)).digest("hex"),
  };
}
