import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
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

function fail(message) {
  failures.push(message);
}

function requireFile(relativePath) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    fail(`required architecture file is missing: ${relativePath}`);
  }
}

function forbid(relativePath, rules) {
  const text = read(relativePath);
  for (const [pattern, reason] of rules) {
    if (pattern.test(text)) {
      fail(`${relativePath}: ${reason}`);
    }
  }
}

const sourceFiles = [
  ...walk("src"),
  ...walk("src-tauri/src"),
].filter((file) => /\.(?:rs|ts|tsx)$/.test(file));

const ratchet = JSON.parse(read("scripts/architecture-ratchet.json"));
const oversized = new Map(Object.entries(ratchet.oversizedFiles));
for (const file of sourceFiles) {
  const filePath = relative(file);
  const lines = lineCount(fs.readFileSync(file, "utf8"));
  const baseline = oversized.get(filePath);
  if (lines > ratchet.sourceLineLimit && baseline === undefined) {
    fail(
      `${filePath}: ${lines} lines exceeds ${ratchet.sourceLineLimit}; split it instead of adding a new exception`,
    );
  }
  if (baseline !== undefined && lines > baseline) {
    fail(`${filePath}: grew from the ratchet ${baseline} to ${lines} lines`);
  }
  if (baseline !== undefined && lines < baseline) {
    fail(
      lines <= ratchet.sourceLineLimit
        ? `${filePath}: is now ${lines} lines; remove its stale ratchet entry`
        : `${filePath}: shrank from ${baseline} to ${lines} lines; lower its ratchet entry`,
    );
  }

  const isFeatureFile =
    filePath.startsWith("src/features/") ||
    filePath.startsWith("src-tauri/src/features/");
  const isTest =
    /\.(?:test|spec)\.[^.]+$/.test(filePath) ||
    /(?:^|\/)[^/]+_tests\.rs$/.test(filePath);
  if (isFeatureFile && !isTest && lines > ratchet.featureFileLineLimit) {
    fail(
      `${filePath}: feature file has ${lines} lines; limit is ${ratchet.featureFileLineLimit}`,
    );
  }
}

for (const [filePath] of oversized) {
  requireFile(filePath);
}

const removedPaths = [
  "src-tauri/src/services/sql_document_service.rs",
  "src-tauri/src/services/connection_service.rs",
  "src-tauri/src/services/connection_credentials.rs",
  "src-tauri/src/services/terminal_authority.rs",
  "src/lib/workbenchDocuments.ts",
  "src/lib/workbenchDocuments.test.ts",
];
for (const filePath of removedPaths) {
  if (fs.existsSync(path.join(root, filePath))) {
    fail(`removed SQL document path returned: ${filePath}`);
  }
}

for (const filePath of [
  "CLAUDE.md",
  "docs/CLI_TERMINAL_PLATFORM_IMPLEMENTATION_PLAN.md",
  "docs/contracts/feature-flags.md",
]) {
  forbid(filePath, [
    [/src\/lib\/workbenchDocuments\.ts/, "active documentation names a removed frontend path"],
    [/src-tauri\/src\/services\/sql_document_service\.rs/, "active documentation names a removed Rust path"],
    [/src-tauri\/src\/services\/connection_service\.rs/, "active documentation names the removed connection service"],
    [/\bsql_documents_v1\b/, "active documentation names the graduated rollout flag"],
  ]);
}

const rustSource = sourceFiles
  .filter((file) => file.endsWith(".rs"))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
for (const token of [
  "SqlDocumentService",
  "ConnectionService",
  "require_sql_documents",
  "FeatureFlag::SqlDocumentsV1",
  "\"sql_documents_v1\"",
]) {
  if (rustSource.includes(token)) {
    fail(`removed SQL document runtime token returned: ${token}`);
  }
}

const coreRustRules = [
  [/crate::connection/, "feature core must not depend on the connection adapter"],
  [/crate::store/, "feature core must not depend on the SQLite store"],
  [/\bsqlx\b/, "feature core must not depend on SQLx"],
  [/\btauri\b/, "feature core must not depend on Tauri"],
  [/crate::state/, "feature core must not depend on global app state"],
  [/crate::services/, "feature core must not depend on the service facade"],
  [/crate::driver/, "feature core must not depend on the driver adapter"],
  [/\bdopedb_protocol\b/, "feature core must not depend on a transport protocol"],
];
for (const filePath of [
  "src-tauri/src/features/connections/domain.rs",
  "src-tauri/src/features/connections/ports.rs",
  "src-tauri/src/features/connections/application.rs",
  "src-tauri/src/features/sql_documents/domain.rs",
  "src-tauri/src/features/sql_documents/ports.rs",
  "src-tauri/src/features/sql_documents/application.rs",
]) {
  requireFile(filePath);
  forbid(filePath, coreRustRules);
}
for (const filePath of [
  "src-tauri/src/kernel/identity.rs",
  "src-tauri/src/kernel/terminal_authority.rs",
]) {
  requireFile(filePath);
  forbid(filePath, coreRustRules);
}
forbid("src-tauri/src/features/connections/transport.rs", [
  [/\bsqlx\b/, "transport must delegate instead of querying SQLite"],
  [/crate::store/, "transport must not read the store directly"],
  [/crate::connection/, "transport must not authorize connections directly"],
  [/crate::driver/, "transport must not call the driver registry directly"],
]);
forbid("src-tauri/src/features/sql_documents/transport.rs", [
  [/\bsqlx\b/, "transport must delegate instead of querying SQLite"],
  [/crate::store/, "transport must not read the store directly"],
  [/crate::connection/, "transport must not authorize connections directly"],
]);

for (const filePath of [
  "src/features/connections/domain.ts",
  "src/features/sqlDocuments/domain.ts",
  "src/features/workbench/domain.ts",
  "src/features/workbench/state.ts",
]) {
  requireFile(filePath);
  forbid(filePath, [
    [/@tauri-apps/, "domain/state must not depend on Tauri"],
    [/ipc\/commands/, "domain/state must not call the IPC command facade"],
    [/\binvoke\s*\(/, "domain/state must not invoke transport commands"],
    [/from\s+["']react["']/, "domain/state must remain independent from React"],
  ]);
}
forbid("src/features/workbench/useWorkbenchDocuments.ts", [
  [/@tauri-apps/, "application hook must use its port instead of Tauri"],
  [/ipc\/commands/, "application hook must use its port instead of IPC commands"],
  [/\binvoke\s*\(/, "application hook must not invoke transport commands"],
]);
forbid("src/features/query/runSignal.ts", [
  [/@tauri-apps/, "query guidance must not depend on Tauri"],
  [/ipc\/commands/, "query guidance must not execute commands"],
  [/\binvoke\s*\(/, "query guidance must not invoke transport commands"],
  [/from\s+["']react["']/, "query guidance must remain independent from React"],
]);

const frontendSource = sourceFiles
  .filter((file) => /\.(?:ts|tsx)$/.test(file))
  .map((file) => [relative(file), fs.readFileSync(file, "utf8")]);
const sqlDocumentCommands = [
  "list_sql_documents",
  "create_sql_document",
  "save_sql_document",
  "delete_sql_document",
];
for (const command of sqlDocumentCommands) {
  const owners = frontendSource
    .filter(([, text]) => text.includes(`"${command}"`))
    .map(([filePath]) => filePath);
  if (
    owners.length !== 1 ||
    owners[0] !== "src/features/sqlDocuments/tauriAdapter.ts"
  ) {
    fail(
      `${command}: expected only src/features/sqlDocuments/tauriAdapter.ts, found ${owners.join(", ") || "none"}`,
    );
  }
}

const connectionCommands = [
  "list_connections",
  "list_drivers",
  "install_driver",
  "upsert_connection",
  "set_connections_schema_group",
  "delete_connection",
  "test_connection",
  "test_connection_profile",
];
for (const command of connectionCommands) {
  const owners = frontendSource
    .filter(([, source]) => source.includes(`"${command}"`))
    .map(([filePath]) => filePath);
  if (
    owners.length !== 1 ||
    owners[0] !== "src/features/connections/tauriAdapter.ts"
  ) {
    fail(
      `${command}: expected only src/features/connections/tauriAdapter.ts, found ${owners.join(", ") || "none"}`,
    );
  }
}
forbid("src/ipc/types.ts", [
  [/\binterface ConnectionProfile\b/, "connection profile returned to the central IPC type file"],
  [/\binterface DriverDescriptor\b/, "driver descriptor returned to the central IPC type file"],
]);
forbid("src/ipc/commands.ts", [
  [/\bfunction listConnections\b/, "connection commands returned to the central IPC facade"],
  [/\bfunction upsertConnection\b/, "connection commands returned to the central IPC facade"],
  [/\bfunction deleteConnection\b/, "connection commands returned to the central IPC facade"],
]);
for (const [filePath, source] of frontendSource) {
  if (
    /import\s+type\s*\{[^}]*\bConnectionProfile\b[^}]*\}\s*from\s*["'][^"']*ipc\/types["']/.test(
      source,
    )
  ) {
    fail(`${filePath}: imports ConnectionProfile from the removed central owner`);
  }
}

const ownership = JSON.parse(read("docs/architecture/state-ownership.json"));
for (const state of ownership.states) {
  requireFile(state.owner);
  requireFile(state.dispatcher);
  for (const token of state.forbiddenWriterTokens) {
    const owners = frontendSource
      .filter(([, text]) => text.includes(token))
      .map(([filePath]) => filePath);
    if (owners.length > 0) {
      fail(`${state.name}: forbidden writer token ${token} found in ${owners.join(", ")}`);
    }
  }
}
for (const state of ownership.runtimeStates ?? []) {
  requireFile(state.owner);
  for (const token of state.writerTokens) {
    const owners = sourceFiles
      .filter((file) => file.endsWith(".rs"))
      .filter((file) => fs.readFileSync(file, "utf8").includes(token))
      .map(relative);
    if (owners.length !== 1 || owners[0] !== state.owner) {
      fail(
        `${state.name}: runtime writer token ${token} must belong only to ${state.owner}, found ${owners.join(", ") || "none"}`,
      );
    }
  }
}
const reducerDispatchers = frontendSource
  .filter(([, text]) => text.includes("useReducer(workbenchReducer"))
  .map(([filePath]) => filePath);
if (
  reducerDispatchers.length !== 1 ||
  reducerDispatchers[0] !==
    "src/features/workbench/useWorkbenchDocuments.ts"
) {
  fail(
    `workbenchDocuments: reducer dispatcher must be unique, found ${reducerDispatchers.join(", ") || "none"}`,
  );
}

if (failures.length > 0) {
  console.error("Architecture contract violations:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Architecture contract OK: ${sourceFiles.length} source files, ${ownership.states.length + (ownership.runtimeStates?.length ?? 0)} owned state(s), migrated legacy paths absent.`,
);
