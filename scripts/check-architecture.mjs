// Executes the split architecture guards as one CI contract. The collectors own
// their domain rules; this file only supplies a deterministic repository view.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectProviderOwnershipDiagnostics } from "./architecture/provider-ownership.mjs";
import { collectQueryCentralIpcDiagnostics } from "./architecture/query-central-ipc-ownership.mjs";
import { collectQueryFrontendOwnershipDiagnostics } from "./architecture/query-frontend-ownership.mjs";
import {
  collectQueryCentralCommandDiagnostics,
  collectQueryProductionModuleDiagnostics,
  collectQueryRuntimeOwnershipDiagnostics,
  collectQuerySharedCoreDiagnostics,
  collectQueryTestModuleDiagnostics,
  collectQueryTauriCommandDiagnostics,
  collectRemovedQueryRuntimeDiagnostics,
  collectRuntimeIdDiagnostics,
} from "./architecture/query-rust-runtime-guards.mjs";
import { collectPoisonMutexDiagnostics } from "./architecture/rust-safety-guards.mjs";
import { collectWorkspaceCloudHttpDiagnostics } from "./architecture/workspace-cloud-http-guards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function walk(directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(absolute, entry.name);
    return entry.isDirectory() ? walk(relative(child)) : [child];
  });
}

function lineCount(text) {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

const sourceFiles = [...walk("src"), ...walk("src-tauri/src")]
  .filter((file) => /\.(?:rs|ts|tsx)$/.test(file));
const frontendSource = sourceFiles
  .filter((file) => /\.(?:ts|tsx)$/.test(file))
  .map((file) => [relative(file), fs.readFileSync(file, "utf8")]);
const frontendProductionSource = frontendSource
  .filter(([filePath]) => !/\.(?:test|spec)\.[^.]+$/.test(filePath));
const rustSource = sourceFiles
  .filter((file) => file.endsWith(".rs"))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
const context = {
  exists,
  lineCount,
  read,
  relative,
  sourceFiles,
  walk,
  // This retained ceiling catches new monoliths while ownership migrations split
  // the existing Provider modules under their separately reviewed workstream.
  ratchet: { featureFileLineLimit: 2_200 },
};

for (const workflow of walk(".github/workflows").filter((file) => /\.ya?ml$/.test(file))) {
  const filePath = relative(workflow);
  for (const match of read(filePath).matchAll(/\buses:\s+([^\s#]+)/g)) {
    const action = match[1];
    if (!action.startsWith("./") && !/@[0-9a-f]{40}$/.test(action)) {
      failures.push(`${filePath}: third-party action must use an immutable full commit SHA (${action})`);
    }
  }
}

for (const collect of [
  collectProviderOwnershipDiagnostics,
  collectQueryProductionModuleDiagnostics,
  collectQueryTestModuleDiagnostics,
  collectQuerySharedCoreDiagnostics,
  collectRuntimeIdDiagnostics,
  collectQueryCentralCommandDiagnostics,
  collectQueryTauriCommandDiagnostics,
  collectQueryRuntimeOwnershipDiagnostics,
  collectPoisonMutexDiagnostics,
  collectWorkspaceCloudHttpDiagnostics,
]) failures.push(...collect(context));
failures.push(...collectRemovedQueryRuntimeDiagnostics(rustSource));
failures.push(...collectQueryCentralIpcDiagnostics(frontendSource));
failures.push(...collectQueryFrontendOwnershipDiagnostics({
  frontendProductionSource,
  frontendSource,
}));

// Knowledge owns feature ports plus SQLite/hosted adapters. The facade and its
// consumers name only ports; raw Store and reqwest ownership stop at their
// corresponding adapters.
const knowledgeRust = walk("src-tauri/src/features/knowledge")
  .map(relative)
  .filter((filePath) => filePath.endsWith(".rs"));
for (const filePath of knowledgeRust) {
  const source = read(filePath);
  if (
    /\b(?:crate::)?features::workspaces::adapters::control_plane\b|\bcrate::features::workspaces::adapters\b/.test(source)
  ) {
    failures.push(`${filePath}: Knowledge must use its feature-owned hosted authority adapter`);
  }
  if (
    /\bcrate::store::Store\b|\buse\s+crate::store::\{[^}]*\bStore\b/s.test(source)
    && filePath !== "src-tauri/src/features/knowledge/adapters/sqlite.rs"
  ) {
    failures.push(`${filePath}: raw Store access is allowed only in the Knowledge SQLite adapter`);
  }
}
if (exists("src-tauri/src/features/knowledge/remote.rs")) {
  failures.push("src-tauri/src/features/knowledge/remote.rs: hosted Knowledge HTTP must remain inside adapters/hosted.rs");
}
for (const [filePath, rules] of [
  ["src-tauri/src/features/knowledge/facade.rs", [
    [/(?:super|crate::features::knowledge)::adapters|\bSqliteKnowledgeRepository\b|\bHostedKnowledgeAuthority\b/, "Knowledge facade must depend on repository and hosted-authority ports"],
    [/\breqwest\b|\bhosted_control_plane\b/, "Knowledge facade must not own hosted HTTP"],
  ]],
  ["src-tauri/src/features/knowledge/transport.rs", [
    [/(?:super|crate::features::knowledge)::adapters|\breqwest\b|\bhosted_control_plane\b/, "Knowledge transport must consume the facade rather than concrete adapters"],
  ]],
  ["src-tauri/src/features/knowledge/ports.rs", [
    [/\breqwest\b|\bhosted_control_plane\b|\bSqliteKnowledgeRepository\b|\bHostedKnowledgeAuthority\b/, "Knowledge ports must remain adapter-neutral"],
  ]],
]) {
  const source = read(filePath);
  for (const [pattern, reason] of rules) {
    if (pattern.test(source)) failures.push(`${filePath}: ${reason}`);
  }
}
if (!read("src-tauri/src/features/knowledge/adapters/hosted.rs").includes("impl HostedKnowledgeAuthorityPort for HostedKnowledgeAuthority")) {
  failures.push("Knowledge hosted adapter must implement HostedKnowledgeAuthorityPort");
}
if (!read("src-tauri/src/features/knowledge/adapters/sqlite.rs").includes("impl KnowledgeRepositoryPort for SqliteKnowledgeRepository")) {
  failures.push("Knowledge SQLite adapter must implement KnowledgeRepositoryPort");
}
for (const directory of ["src-tauri/src/features/analysis_articles", "src-tauri/src/broker"]) {
  for (const filePath of walk(directory).map(relative).filter((candidate) => candidate.endsWith(".rs"))) {
    if (/features::knowledge::adapters|features::knowledge::remote/.test(read(filePath))) {
      failures.push(`${filePath}: cross-feature Knowledge consumers must use KnowledgeFeature ports`);
    }
  }
}
for (const directory of ["src-tauri/src/features/analysis_articles", "src-tauri/src/broker"]) {
  for (const filePath of walk(directory).map(relative).filter((candidate) => candidate.endsWith(".rs"))) {
    if (
      /\b(?:crate::)?features::workspaces::adapters::control_plane\b|\bcrate::features::workspaces::adapters\b/.test(read(filePath))
    ) {
      failures.push(`${filePath}: feature must not import the concrete Workspace control-plane adapter`);
    }
  }
}
if (/\bknowledge_store\s*\(/.test(rustSource)) {
  failures.push("removed raw AppState::knowledge_store accessor returned");
}
if (!read("src-tauri/src/services/mod.rs").includes("pub(crate) knowledge: KnowledgeFeature")) {
  failures.push("ApplicationServices must expose the KnowledgeFeature facade, not a raw Store");
}

// Analysis Articles owns explicit local-repository, exact-read-execution, and
// hosted-authority ports. The generic facade and business runner must remain
// independent of SQLite, connection pools, HTTP, Tauri, and global AppState.
const analysisRoot = "src-tauri/src/features/analysis_articles";
const analysisAdapters = `${analysisRoot}/adapters`;
for (const filePath of walk(analysisRoot).map(relative).filter((candidate) => candidate.endsWith(".rs"))) {
  const source = read(filePath);
  const adapter = filePath.startsWith(`${analysisAdapters}/`);
  if (
    /\bcrate::store::Store\b|\buse\s+crate::store::\{[^}]*\bStore\b/s.test(source)
    && !adapter
    && filePath !== `${analysisRoot}/mod.rs`
  ) {
    failures.push(`${filePath}: raw Store access is allowed only in Analysis adapters and composition`);
  }
  if (
    /\bConnectionManager\b|\bConnectionAccess\b|\bDbPool\b/.test(source)
    && !adapter
    && filePath !== `${analysisRoot}/mod.rs`
  ) {
    failures.push(`${filePath}: connection runtime access is allowed only in the Analysis read adapter and composition`);
  }
  if (/\breqwest\b|\bhosted_control_plane\b/.test(source) && filePath !== `${analysisAdapters}/hosted.rs`) {
    failures.push(`${filePath}: Analysis hosted HTTP is allowed only in adapters/hosted.rs`);
  }
}
for (const [filePath, rules] of [
  [`${analysisRoot}/facade.rs`, [
    [/\bcrate::(?:store|connection|state|hosted_control_plane)(?:::|\b)|\breqwest(?:::|\b)|\bsqlx(?:::|\b)|\btauri(?:::|\b)/, "Analysis facade must depend only on feature ports"],
    [/(?:super|crate::features::analysis_articles)::adapters|\b(?:SqliteAnalysisLocalRepository|DesktopAnalysisReadExecution|HostedAnalysisAuthority)\b/, "Analysis facade must not name concrete adapters"],
  ]],
  [`${analysisRoot}/runner.rs`, [
    [/\bcrate::(?:store|connection|state|hosted_control_plane|audit)(?:::|\b)|\breqwest(?:::|\b)|\bsqlx(?:::|\b)|\btauri(?:::|\b)/, "Analysis runner must delegate platform execution through its read port"],
  ]],
  [`${analysisRoot}/ports.rs`, [
    [/\bcrate::(?:store|connection|state|hosted_control_plane)(?:::|\b)|\breqwest(?:::|\b)|\bsqlx(?:::|\b)|\btauri(?:::|\b)/, "Analysis ports must remain adapter-neutral"],
  ]],
]) {
  const source = read(filePath);
  for (const [pattern, reason] of rules) {
    if (pattern.test(source)) failures.push(`${filePath}: ${reason}`);
  }
}
if (exists(`${analysisRoot}/remote.rs`)) {
  failures.push(`${analysisRoot}/remote.rs: Analysis hosted HTTP must remain inside adapters/hosted.rs`);
}
if (!read(`${analysisAdapters}/hosted.rs`).includes("impl AnalysisHostedAuthorityPort for HostedAnalysisAuthority")) {
  failures.push("Analysis hosted adapter must implement AnalysisHostedAuthorityPort");
}
if (!read(`${analysisAdapters}/sqlite.rs`).includes("impl AnalysisLocalRepositoryPort for SqliteAnalysisLocalRepository")) {
  failures.push("Analysis SQLite adapter must implement AnalysisLocalRepositoryPort");
}
if (!read(`${analysisAdapters}/desktop_read.rs`).includes("impl AnalysisReadExecutionPort for DesktopAnalysisReadExecution")) {
  failures.push("Analysis Desktop read adapter must implement AnalysisReadExecutionPort");
}

// Hosted workspace responses are untrusted network input. Request serialization
// may use `.json(&value)`, but response bodies must pass through the shared
// content-type and byte-cap reader before deserialization.
for (const filePath of [
  "src-tauri/src/features/workspaces/adapters/control_plane/authentication.rs",
  "src-tauri/src/features/workspaces/adapters/control_plane/connections.rs",
  "src-tauri/src/features/workspaces/adapters/control_plane/sync.rs",
]) {
  const source = read(filePath);
  if (/\.json\s*(?:::\s*<[^>]+>)?\s*\(\s*\)\s*\.await/s.test(source)) {
    failures.push(`${filePath}: hosted response JSON must use bounded_json_response`);
  }
  if (!source.includes("hosted_control_plane::bounded_json_response")) {
    failures.push(`${filePath}: hosted response parser must use the shared bounded reader`);
  }
}

// Rust's Knowledge wire contract rejects every Unicode control character. Keep
// cloud ingestion from accepting C1 controls (U+0080-U+009F) that would survive
// until Desktop validation and make an otherwise activated graph unusable.
for (const directory of [
  "workspace-cloud/lib/knowledge",
  "workspace-cloud/app/api/v1/knowledge",
  "workspace-cloud/app/api/v1/workspaces/[workspaceId]/knowledge",
]) {
  for (const filePath of walk(directory).map(relative).filter((candidate) => candidate.endsWith(".ts"))) {
    if (/\\u0000-\\u001f\\u007f\]/.test(read(filePath))) {
      failures.push(`${filePath}: Knowledge text validation must reject C1 controls through \\u009f`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of [...new Set(failures)].sort()) console.error(`architecture: ${failure}`);
  process.exit(1);
}
console.log("architecture ownership guards ok");
