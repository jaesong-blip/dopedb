// Convert Graphify's AST-only graph into DopeDB's bounded, provider-neutral
// GraphBuildArtifact v1. Semantic/LLM edges are intentionally discarded.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_NODES = 200_000;
const MAX_EDGES = 600_000;
const MAX_EVIDENCE = 600_000;
const scriptSha256 = sha256(await readFile(resolve(import.meta.filename)));

if (process.argv.includes("--check")) {
  const fixture = resolve(import.meta.dirname, "fixtures/graphify-code-only-v1.json");
  const parameters = fixtureParameters();
  const first = await convert(fixture, parameters);
  const second = await convert(fixture, parameters);
  assert(JSON.stringify(first) === JSON.stringify(second), "converter is not deterministic");
  assert(first.nodes.length === 3 && first.edges.length === 2, "fixture graph projection changed");
  assert(first.edges.every((edge) => ["defines", "calls"].includes(edge.relation)), "semantic edge leaked");
  assert(!JSON.stringify(first).includes("ignored semantic summary"), "non-AST graph data leaked");
  console.log("verified GraphBuildArtifact v1 converter boundary");
  process.exit(0);
}

const args = argumentMap(process.argv.slice(2));
const input = resolve(required(args, "--input"));
const output = resolve(required(args, "--output"));
if (input === output) fail("input and output must differ");
const artifact = await convert(input, {
  sourceId: uuid(required(args, "--source-id")),
  projectId: uuid(required(args, "--project-id")),
  environmentId: uuid(required(args, "--environment-id")),
  environmentRevision: positiveInteger(required(args, "--environment-revision")),
  provider: provider(required(args, "--provider")),
  displayName: safeText(required(args, "--display-name")),
  visibility: visibility(required(args, "--visibility")),
  revision: JSON.parse(required(args, "--revision-json")),
  parentGraphRevisionId: optionalUuid(args.get("--parent-graph-revision-id")),
  generatedAt: timestamp(required(args, "--generated-at")),
  health: JSON.parse(required(args, "--health-json")),
  changedFiles: JSON.parse(args.get("--changed-files-json") ?? "[]"),
});
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(output);

async function convert(inputPath, parameters) {
  const inputBytes = await readBounded(inputPath, MAX_INPUT_BYTES);
  const source = JSON.parse(inputBytes);
  validateParameters(parameters);
  if (!Array.isArray(source.nodes) || !Array.isArray(source.links)) fail("invalid Graphify graph shape");
  if (source.multigraph !== true || source.directed !== true) fail("Graphify graph must be directed multigraph");
  if (source.nodes.length > MAX_NODES * 2 || source.links.length > MAX_EDGES * 2) fail("Graphify input exceeds bounds");

  const astNodes = new Map(source.nodes
    .filter((node) => node?._origin === "ast" && safeGraphifyId(node.id))
    .map((node) => [node.id, node]));
  const projectedLinks = source.links
    .filter((link) => link?._origin === "ast")
    .map((link) => ({ link, relation: relation(link.relation) }))
    .filter(({ link, relation }) => relation && astNodes.has(link.source) && astNodes.has(link.target));
  if (projectedLinks.length > MAX_EDGES) fail("projected graph exceeds edge bound");

  const usedIds = new Set(projectedLinks.flatMap(({ link }) => [link.source, link.target]));
  const sourceRevisionSha256 = sha256(Buffer.from(canonical(parameters.revision)));
  const nodeId = new Map();
  const nodes = [...usedIds].sort().map((id) => {
    const node = astNodes.get(id);
    const projectedId = sha256(Buffer.from(`node\0${parameters.sourceId}\0${id}`));
    nodeId.set(id, projectedId);
    return {
      id: projectedId,
      kind: nodeKind(node),
      name: safeText(String(node.label ?? node.norm_label ?? id)),
      qualifiedName: safeText(`${safePath(node.source_file)}#${String(node.norm_label ?? id)}`),
      attributes: {
        language: safeText(String(node.metadata?.language ?? "unknown")),
        extractionKind: safeText(String(node.metadata?.kind ?? node.file_type ?? "code")),
      },
    };
  });
  if (nodes.length > MAX_NODES) fail("projected graph exceeds node bound");

  const evidenceById = new Map();
  const edges = projectedLinks.map(({ link, relation: edgeRelation }, index) => {
    const filePath = safePath(link.source_file ?? astNodes.get(link.source).source_file);
    const [lineStart, lineEnd] = sourceLines(link.source_location ?? astNodes.get(link.source).source_location);
    const evidenceId = sha256(Buffer.from(`evidence\0${sourceRevisionSha256}\0${filePath}\0${lineStart}\0${lineEnd}\0${edgeRelation}\0${index}`));
    evidenceById.set(evidenceId, {
      id: evidenceId,
      sourceId: parameters.sourceId,
      sourceRevisionSha256,
      filePath,
      lineStart,
      lineEnd,
      extractionMethod: "graphify_ast",
      observedAt: parameters.generatedAt,
    });
    const from = nodeId.get(link.source);
    const to = nodeId.get(link.target);
    return {
      id: sha256(Buffer.from(`edge\0${from}\0${to}\0${edgeRelation}\0${evidenceId}`)),
      from,
      to,
      relation: edgeRelation,
      state: "EXTRACTED",
      evidenceIds: [evidenceId],
    };
  });
  const evidence = [...evidenceById.values()].sort((left, right) => left.id.localeCompare(right.id, "en"));
  edges.sort((left, right) => left.id.localeCompare(right.id, "en"));
  if (evidence.length > MAX_EVIDENCE) fail("projected graph exceeds evidence bound");

  const binding = {
    sourceId: parameters.sourceId,
    projectId: parameters.projectId,
    projectEnvironmentId: parameters.environmentId,
    provider: parameters.provider,
    displayName: parameters.displayName,
    visibility: parameters.visibility,
    revision: parameters.revision,
  };
  const identity = canonical({ binding, environmentRevision: parameters.environmentRevision, sourceRevisionSha256, nodes, edges, evidence });
  return {
    schemaVersion: 1,
    graphRevisionId: uuidFromSha256(sha256(Buffer.from(identity))),
    environmentRevision: parameters.environmentRevision,
    binding,
    sourceRevisionSha256,
    parentGraphRevisionId: parameters.parentGraphRevisionId,
    extractor: { id: "dopedb.graphify-code", version: "1.0.0", sourceSha256: scriptSha256 },
    generatedAt: parameters.generatedAt,
    health: parameters.health,
    changedFiles: [...new Set(parameters.changedFiles.map(safePath))].sort(),
    nodes,
    edges,
    evidence,
  };
}

function fixtureParameters() {
  return {
    sourceId: "018f0000-0000-7000-8000-000000000001",
    projectId: "018f0000-0000-7000-8000-000000000002",
    environmentId: "018f0000-0000-7000-8000-000000000003",
    environmentRevision: 1,
    provider: "github",
    displayName: "json-choi/dopedb",
    visibility: "shared_graph",
    revision: { kind: "github", repository_id: "R_fixture", repository: "json-choi/dopedb", ref_name: "refs/heads/main", commit_sha: "a".repeat(40) },
    parentGraphRevisionId: null,
    generatedAt: "2026-08-08T00:00:00Z",
    health: { complete: true, parsedFiles: 1, skippedFiles: 0, failedFiles: 0 },
    changedFiles: ["src/main.ts"],
  };
}

function validateParameters(value) {
  uuid(value.sourceId); uuid(value.projectId); uuid(value.environmentId);
  positiveInteger(value.environmentRevision); provider(value.provider); visibility(value.visibility);
  safeText(value.displayName); timestamp(value.generatedAt);
  assert(value.health?.complete === true && value.health.failedFiles === 0, "unhealthy Graphify build");
  for (const key of ["parsedFiles", "skippedFiles", "failedFiles"]) positiveIntegerOrZero(value.health[key]);
  assert(Array.isArray(value.changedFiles) && value.changedFiles.length <= 100_000, "invalid changed files");
  validateRevision(value.provider, value.visibility, value.revision);
}

function validateRevision(selectedProvider, selectedVisibility, value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "invalid source revision");
  if (selectedProvider === "github") {
    assert(value.kind === "github" && /^[0-9a-f]{40}$/.test(value.commit_sha), "invalid GitHub revision");
    safeText(value.repository_id); safeText(value.repository); safeText(value.ref_name);
  } else if (value.kind === "local_git") {
    assert(/^[0-9a-f]{64}$/.test(value.root_fingerprint) && /^[0-9a-f]{64}$/.test(value.git_root_fingerprint), "invalid Local Git fingerprints");
    assert(/^[0-9a-f]{40}$/.test(value.commit_sha), "invalid Local Git commit");
    assert(typeof value.dirty === "boolean" && typeof value.worktree === "boolean", "invalid Local Git flags");
    assert(!(selectedVisibility === "shared_graph" && value.dirty), "dirty Local graph cannot be shared");
  } else {
    assert(value.kind === "local_snapshot" && /^[0-9a-f]{64}$/.test(value.root_fingerprint) && /^[0-9a-f]{64}$/.test(value.snapshot_sha256), "invalid local snapshot");
  }
}

function relation(value) {
  if (value === "defines") return "defines";
  if (["imports", "imports_from", "re_exports"].includes(value)) return "imports";
  if (["calls", "indirect_call"].includes(value)) return "calls";
  return null;
}

function nodeKind(node) {
  const kind = String(node.metadata?.kind ?? "").toLowerCase();
  if (kind === "file") return "file";
  if (kind.includes("module") || kind.includes("package")) return "module";
  if (["class", "struct", "enum", "interface", "trait", "type"].some((value) => kind.includes(value))) return "type";
  if (["function", "method", "entrypoint", "closure"].some((value) => kind.includes(value))) return "function";
  return node.file_type === "document" ? "file" : "function";
}

function sourceLines(value) {
  const match = String(value ?? "").match(/^L(\d+)(?:-L?(\d+))?$/);
  if (!match) return [1, 1];
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return [start, Math.max(start, end)];
}

function safePath(value) {
  const path = String(value ?? "").split(sep).join("/");
  assert(path.length > 0 && path.length <= 16_384 && !path.startsWith("/") && !path.includes("\\"), "unsafe source path");
  assert(path.split("/").every((segment) => segment && segment !== "." && segment !== ".."), "unsafe source path");
  return path;
}

function safeGraphifyId(value) { return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\0-\x1f\x7f]/.test(value); }
function safeText(value) { assert(typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\0-\x1f\x7f]/.test(value), "unsafe text"); return value; }
function provider(value) { assert(["github", "local_folder"].includes(value), "unsupported provider"); return value; }
function visibility(value) { assert(["local_only", "shared_graph"].includes(value), "invalid visibility"); return value; }
function timestamp(value) { assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value), "invalid timestamp"); return value; }
function uuid(value) { assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), "invalid UUID"); return value.toLowerCase(); }
function optionalUuid(value) { return value ? uuid(value) : null; }
function positiveInteger(value) { const number = Number(value); assert(Number.isSafeInteger(number) && number > 0, "invalid positive integer"); return number; }
function positiveIntegerOrZero(value) { const number = Number(value); assert(Number.isSafeInteger(number) && number >= 0, "invalid non-negative integer"); return number; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function uuidFromSha256(hash) { return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${hash.slice(18, 20)}-${hash.slice(20, 32)}`; }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function argumentMap(values) { const result = new Map(); for (let index = 0; index < values.length; index += 2) result.set(values[index], values[index + 1] ?? ""); return result; }
function required(values, key) { const value = values.get(key); if (!value) fail(`missing ${key}`); return value; }
async function readBounded(path, maximum) { const bytes = await readFile(path); assert(bytes.length > 0 && bytes.length <= maximum, "Graphify input size is invalid"); return bytes; }
function assert(condition, message) { if (!condition) fail(message); }
function fail(message) { throw new Error(message); }
