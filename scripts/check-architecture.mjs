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
  "src-tauri/src/services/catalog_service.rs",
  "src-tauri/src/services/workspace_service.rs",
  "src-tauri/src/workspace_auth.rs",
  "src/lib/workbenchDocuments.ts",
  "src/lib/workbenchDocuments.test.ts",
  "src/lib/workspaceAccounts.ts",
  "src/lib/workspaceAccounts.test.ts",
  "src/lib/workspaceAuthLifecycle.ts",
  "src/lib/workspaceAuthLifecycle.test.ts",
  "src/components/WorkspaceAccount.tsx",
  "src/components/WorkspaceAccount.css",
  "src/components/WorkspaceSwitcher.tsx",
  "src/components/WorkspaceSwitcher.css",
  "src/components/WorkspaceConnectionDialog.tsx",
  "src/components/WorkspaceConnectionDialog.css",
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
    [/src-tauri\/src\/services\/catalog_service\.rs/, "active documentation names the removed catalog service"],
    [/src-tauri\/src\/services\/workspace_service\.rs/, "active documentation names the removed workspace service"],
    [/src-tauri\/src\/workspace_auth\.rs/, "active documentation names the removed global workspace auth module"],
    [/src\/lib\/workspaceAccounts\.ts/, "active documentation names a removed workspace account helper"],
    [/src\/lib\/workspaceAuthLifecycle\.ts/, "active documentation names a removed workspace auth helper"],
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
  "CatalogService",
  "require_sql_documents",
  "FeatureFlag::SqlDocumentsV1",
  "\"sql_documents_v1\"",
  "WorkspaceService",
  "crate::workspace_auth",
]) {
  if (rustSource.includes(token)) {
    fail(`removed SQL document runtime token returned: ${token}`);
  }
}
const directCatalogLoaders = sourceFiles
  .filter((file) => file.endsWith(".rs"))
  .filter((file) => fs.readFileSync(file, "utf8").includes("introspect::load_catalog"))
  .map(relative);
if (
  directCatalogLoaders.length !== 1 ||
  directCatalogLoaders[0] !== "src-tauri/src/features/catalog/adapters/local.rs"
) {
  fail(
    `catalog introspection must belong only to src-tauri/src/features/catalog/adapters/local.rs, found ${directCatalogLoaders.join(", ") || "none"}`,
  );
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
  "src-tauri/src/features/workspaces/domain.rs",
  "src-tauri/src/features/workspaces/ports.rs",
  "src-tauri/src/features/workspaces/application.rs",
  ...walk("src-tauri/src/features/workspaces/application")
    .filter((file) => file.endsWith(".rs"))
    .map(relative),
]) {
  requireFile(filePath);
  forbid(filePath, coreRustRules);
}
for (const filePath of [
  "src-tauri/src/features/catalog/domain.rs",
  "src-tauri/src/features/catalog/ports.rs",
  "src-tauri/src/features/catalog/application.rs",
]) {
  requireFile(filePath);
  forbid(
    filePath,
    coreRustRules.filter(([pattern]) => pattern.source !== "\\bdopedb_protocol\\b"),
  );
  forbid(filePath, [
    [
      /\bdopedb_protocol::(?!catalog\b)/,
      "catalog core may use only the transport-independent versioned catalog contract",
    ],
  ]);
}
for (const filePath of [
  "src-tauri/src/features/workspaces/domain.rs",
  "src-tauri/src/features/workspaces/ports.rs",
  "src-tauri/src/features/workspaces/application.rs",
  ...walk("src-tauri/src/features/workspaces/application")
    .filter((file) => file.endsWith(".rs"))
    .map(relative),
]) {
  forbid(filePath, [
    [/\breqwest\b/, "workspace core must not depend on HTTP"],
    [/crate::connection::keychain|keyring::/, "workspace core must not depend on the credential store adapter"],
    [/\bstd::env\b/, "workspace core must not read process configuration"],
    [/adapters::/, "workspace core must not depend on concrete adapters"],
  ]);
}
for (const filePath of [
  "src-tauri/src/kernel/identity.rs",
  "src-tauri/src/kernel/terminal_authority.rs",
  "src-tauri/src/connection/remote_authority.rs",
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
forbid("src-tauri/src/features/catalog/transport.rs", [
  [/\bsqlx\b/, "catalog transport must delegate instead of querying SQLite"],
  [/crate::store/, "catalog transport must not read the store directly"],
  [/crate::connection/, "catalog transport must not access connection pools directly"],
  [/crate::introspect/, "catalog transport must not introspect directly"],
]);
forbid("src-tauri/src/introspect/mod.rs", [
  [/\bpub struct Catalog\b/, "catalog model returned to the introspection adapter"],
  [/\bpub struct Column\b/, "catalog column model returned to the introspection adapter"],
  [/\bpub struct Table\b/, "catalog table model returned to the introspection adapter"],
]);
forbid("src-tauri/src/commands/mod.rs", [
  [/\bpub async fn get_schema\b/, "catalog command returned to the central command module"],
  [/\bpub async fn refresh_schema\b/, "catalog refresh returned to the central command module"],
  [/\bpub async fn get_catalog_snapshot\b/, "catalog snapshot returned to the central command module"],
  [/\bpub async fn get_table_ddl\b/, "catalog DDL command returned to the central command module"],
]);
forbid("src-tauri/src/features/sql_documents/transport.rs", [
  [/\bsqlx\b/, "transport must delegate instead of querying SQLite"],
  [/crate::store/, "transport must not read the store directly"],
  [/crate::connection/, "transport must not authorize connections directly"],
]);
forbid("src-tauri/src/features/workspaces/transport.rs", [
  [/\bsqlx\b/, "workspace transport must delegate instead of querying SQLite"],
  [/crate::store/, "workspace transport must not read the store directly"],
  [/crate::connection/, "workspace transport must not mutate connection pools directly"],
  [/\breqwest\b/, "workspace transport must not call the control plane directly"],
  [/\bkeychain\b/, "workspace transport must not access credentials directly"],
]);
forbid("src-tauri/src/connection/runtime.rs", [
  [/workspace_auth/, "connection runtime must use its injected remote authority"],
  [/HostedWorkspaceControlPlane/, "connection runtime must not construct a hosted adapter"],
]);

for (const filePath of [
  "src/features/connections/domain.ts",
  "src/features/sqlDocuments/domain.ts",
  "src/features/workspaces/domain.ts",
  "src/features/workspaces/cache.ts",
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
const workspaceCommands = [
  "workspace_feature_state",
  "workspace_auth_state",
  "refresh_workspace_auth_state",
  "workspace_sign_out",
  "workspace_sign_out_all",
  "begin_workspace_login",
  "poll_workspace_login",
  "workspace_console_url",
  "list_workspaces",
  "refresh_workspace_memberships",
  "get_active_workspace",
  "set_active_workspace",
  "set_active_workspace_account",
  "copy_connection_to_workspace",
  "bind_workspace_connection_credentials",
];
for (const command of workspaceCommands) {
  const owners = frontendSource
    .filter(([, source]) => source.includes(`"${command}"`))
    .map(([filePath]) => filePath);
  if (
    owners.length !== 1 ||
    owners[0] !== "src/features/workspaces/tauriAdapter.ts"
  ) {
    fail(
      `${command}: expected only src/features/workspaces/tauriAdapter.ts, found ${owners.join(", ") || "none"}`,
    );
  }
}
forbid("src/ipc/types.ts", [
  [/\binterface ConnectionProfile\b/, "connection profile returned to the central IPC type file"],
  [/\binterface DriverDescriptor\b/, "driver descriptor returned to the central IPC type file"],
  [/\binterface Workspace\b/, "workspace type returned to the central IPC type file"],
  [/\binterface WorkspaceAuth/, "workspace auth type returned to the central IPC type file"],
]);
forbid("src/ipc/commands.ts", [
  [/\bfunction listConnections\b/, "connection commands returned to the central IPC facade"],
  [/\bfunction upsertConnection\b/, "connection commands returned to the central IPC facade"],
  [/\bfunction deleteConnection\b/, "connection commands returned to the central IPC facade"],
  [/\bfunction listWorkspaces\b/, "workspace commands returned to the central IPC facade"],
  [/\bfunction workspaceAuthState\b/, "workspace auth returned to the central IPC facade"],
  [/\bfunction setActiveWorkspace\b/, "workspace selection returned to the central IPC facade"],
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
  for (const token of state.writerTokens ?? []) {
    const owners = frontendSource
      .filter(([, text]) => text.includes(token))
      .map(([filePath]) => filePath);
    if (owners.length !== 1 || owners[0] !== state.owner) {
      fail(
        `${state.name}: writer token ${token} must belong only to ${state.owner}, found ${owners.join(", ") || "none"}`,
      );
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
