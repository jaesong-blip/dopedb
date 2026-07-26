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
  if (
    isFeatureFile &&
    !isTest &&
    lines > ratchet.featureFileLineLimit &&
    baseline === undefined
  ) {
    fail(
      `${filePath}: feature file has ${lines} lines; split it or record only an existing migration baseline`,
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
  "src-tauri/src/services/erd_service.rs",
  "src-tauri/src/services/schema_service.rs",
  "src-tauri/src/services/dashboard_service.rs",
  "src-tauri/src/dashboard.rs",
  "src-tauri/src/services/job_service/model.rs",
  "src-tauri/src/services/job_service/mod.rs",
  "src-tauri/src/services/job_service/format.rs",
  "src-tauri/src/services/job_service/repository.rs",
  "src-tauri/src/services/job_service/worker.rs",
  "src-tauri/src/features/jobs/application.rs",
  "src-tauri/src/features/jobs/adapters/ledger.rs",
  "src-tauri/src/features/jobs/adapters/worker.rs",
  "src-tauri/src/features/jobs/adapters/format.rs",
  "src-tauri/src/services/workspace_service.rs",
  "src-tauri/src/workspace_auth.rs",
  "src-tauri/src/terminal/environment.rs",
  "src-tauri/src/terminal/manager.rs",
  "src-tauri/src/terminal/mod.rs",
  "src-tauri/src/terminal/model.rs",
  "src-tauri/src/terminal/output.rs",
  "src-tauri/src/terminal/process_tree.rs",
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
  "src/components/TerminalDock/terminalState.ts",
  "src/components/TerminalDock/terminalState.test.ts",
];
for (const filePath of removedPaths) {
  if (fs.existsSync(path.join(root, filePath))) {
    fail(`removed legacy path returned: ${filePath}`);
  }
}
const returnedLegacyTerminalFiles = walk("src-tauri/src/terminal").map(relative);
if (returnedLegacyTerminalFiles.length > 0) {
  fail(
    `removed legacy path returned: ${returnedLegacyTerminalFiles.join(", ")}`,
  );
}
const legacyTerminalStateFiles = walk("src/components/TerminalDock")
  .map(relative)
  .filter((filePath) => path.basename(filePath).startsWith("terminalState"));
if (legacyTerminalStateFiles.length > 0) {
  fail(
    `removed legacy Terminal state path returned: ${legacyTerminalStateFiles.join(", ")}`,
  );
}

for (const filePath of [
  "CLAUDE.md",
  "docs/CLI_TERMINAL_PLATFORM_IMPLEMENTATION_PLAN.md",
  "docs/contracts/feature-flags.md",
  "docs/contracts/job-engine.md",
]) {
  forbid(filePath, [
    [/src\/lib\/workbenchDocuments\.ts/, "active documentation names a removed frontend path"],
    [/src-tauri\/src\/services\/sql_document_service\.rs/, "active documentation names a removed Rust path"],
    [/src-tauri\/src\/services\/connection_service\.rs/, "active documentation names the removed connection service"],
    [/\bcatalog_service\.rs\b/, "active documentation names the removed catalog service"],
    [/\bdashboard_service\.rs\b/, "active documentation names the removed dashboard service"],
    [/src-tauri\/src\/dashboard\.rs/, "active documentation names the removed global dashboard policy module"],
    [/src-tauri\/src\/services\/job_service/, "active documentation names the removed job service tree"],
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
  "ErdService",
  "SchemaService",
  "DashboardService",
  "AgentDashboardPrepareError",
  "AgentDashboardCommitError",
  "PreparedAgentDashboard",
  "JobService",
  "require_sql_documents",
  "FeatureFlag::SqlDocumentsV1",
  "\"sql_documents_v1\"",
  "WorkspaceService",
  "crate::workspace_auth",
]) {
  if (rustSource.includes(token)) {
    fail(`removed runtime token returned: ${token}`);
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
const jobLedgerSql = [
  "INSERT INTO job_file_capabilities",
  "UPDATE job_file_capabilities",
  "INSERT INTO jobs",
  "UPDATE jobs",
  "INSERT INTO job_checkpoints",
  "INSERT INTO job_artifacts",
  "INSERT INTO job_events",
];
for (const token of jobLedgerSql) {
  const owners = sourceFiles
    .filter((file) => file.endsWith(".rs"))
    .filter((file) => !relative(file).endsWith("_tests.rs"))
    .filter((file) => fs.readFileSync(file, "utf8").includes(token))
    .map(relative);
  if (
    owners.length === 0 ||
    owners.some(
      (owner) =>
        !owner.startsWith("src-tauri/src/features/jobs/adapters/ledger/"),
    )
  ) {
    fail(
      `job ledger SQL ${token} must belong only to the Job ledger adapter, found ${owners.join(", ") || "none"}`,
    );
  }
}
for (const token of ["INSERT INTO erd_layouts", "UPDATE erd_layouts"]) {
  const owners = sourceFiles
    .filter((file) => file.endsWith(".rs"))
    .filter((file) => !relative(file).endsWith("_tests.rs"))
    .filter((file) => fs.readFileSync(file, "utf8").includes(token))
    .map(relative);
  if (
    owners.length !== 1 ||
    owners[0] !== "src-tauri/src/features/erd/adapters/repository.rs"
  ) {
    fail(
      `ERD layout SQL ${token} must belong only to the ERD repository adapter, found ${owners.join(", ") || "none"}`,
    );
  }
}
for (const token of ["INSERT INTO dashboards", "UPDATE dashboards SET deleted_at"]) {
  const owners = sourceFiles
    .filter((file) => file.endsWith(".rs"))
    .filter((file) => !relative(file).endsWith("_tests.rs"))
    .filter((file) => fs.readFileSync(file, "utf8").includes(token))
    .map(relative);
  if (
    owners.length !== 1 ||
    owners[0] !== "src-tauri/src/store/mod.rs"
  ) {
    fail(
      `dashboard mutation SQL ${token} must belong only to the dashboard store writer, found ${owners.join(", ") || "none"}`,
    );
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
  "src-tauri/src/features/erd/ports.rs",
  "src-tauri/src/features/erd/application.rs",
]) {
  requireFile(filePath);
  forbid(filePath, coreRustRules);
}
for (const filePath of ["src-tauri/src/features/erd/domain.rs"]) {
  requireFile(filePath);
  forbid(
    filePath,
    coreRustRules.filter(([pattern]) => pattern.source !== "\\bdopedb_protocol\\b"),
  );
  forbid(filePath, [
    [
      /\bdopedb_protocol::(?!catalog\b)/,
      "ERD core may use only canonical catalog object references",
    ],
  ]);
}
for (const filePath of [
  "src-tauri/src/features/schema_editor/domain.rs",
  "src-tauri/src/features/schema_editor/ports.rs",
  "src-tauri/src/features/schema_editor/application.rs",
]) {
  requireFile(filePath);
  forbid(
    filePath,
    coreRustRules.filter(([pattern]) => pattern.source !== "\\bdopedb_protocol\\b"),
  );
  forbid(filePath, [
    [/crate::ddl/, "schema-editor core must use its planner port"],
    [/crate::features::catalog/, "schema-editor core must use its catalog port"],
    [/ScriptService/, "schema-editor core must use its script port"],
  ]);
}
for (const filePath of [
  "src-tauri/src/features/dashboards/domain.rs",
  "src-tauri/src/features/dashboards/ports.rs",
  "src-tauri/src/features/dashboards/application.rs",
]) {
  requireFile(filePath);
  forbid(filePath, coreRustRules);
}
for (const filePath of [
  "src-tauri/src/features/jobs/domain.rs",
  "src-tauri/src/features/jobs/state_machine.rs",
  "src-tauri/src/features/jobs/validation.rs",
]) {
  requireFile(filePath);
  forbid(
    filePath,
    coreRustRules.filter(([pattern]) => pattern.source !== "\\bdopedb_protocol\\b"),
  );
  forbid(filePath, [
    [
      /\bdopedb_protocol::(?!catalog\b|operation\b)/,
      "job core may use only canonical catalog and operation contracts",
    ],
  ]);
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
  [/\bpub struct DatabaseObject\b/, "catalog object model returned to the introspection adapter"],
  [/\bpub struct ForeignKey\b/, "catalog foreign-key model returned to the introspection adapter"],
  [/\bpub struct Index\b/, "catalog index model returned to the introspection adapter"],
  [/\bpub struct Table\b/, "catalog table model returned to the introspection adapter"],
]);
forbid("src-tauri/src/commands/mod.rs", [
  [/\bpub async fn get_schema\b/, "catalog command returned to the central command module"],
  [/\bpub async fn refresh_schema\b/, "catalog refresh returned to the central command module"],
  [/\bpub async fn get_catalog_snapshot\b/, "catalog snapshot returned to the central command module"],
  [/\bpub async fn get_table_ddl\b/, "catalog DDL command returned to the central command module"],
  [/\bpub async fn pick_job_input\b/, "job input picker returned to the central command module"],
  [/\bpub async fn pick_job_output\b/, "job output picker returned to the central command module"],
  [/\bpub async fn inspect_job_input\b/, "job inspection returned to the central command module"],
  [/\bpub async fn create_job\b/, "job creation returned to the central command module"],
  [/\bpub async fn list_jobs\b/, "job listing returned to the central command module"],
  [/\bpub async fn get_job\b/, "job detail returned to the central command module"],
  [/\bpub async fn start_job\b/, "job start returned to the central command module"],
  [/\bpub async fn pause_job\b/, "job pause returned to the central command module"],
  [/\bpub async fn cancel_job\b/, "job cancellation returned to the central command module"],
  [/\bpub async fn reveal_job_artifact\b/, "job artifact reveal returned to the central command module"],
  [/\bpub async fn list_erd_layouts\b/, "ERD list returned to the central command module"],
  [/\bpub async fn save_erd_layout\b/, "ERD save returned to the central command module"],
  [/\bpub async fn delete_erd_layout\b/, "ERD delete returned to the central command module"],
  [/\bpub async fn preview_schema_change\b/, "schema preview returned to the central command module"],
  [/\bpub async fn propose_schema_change\b/, "schema proposal returned to the central command module"],
  [/\bpub async fn run_schema_change\b/, "schema execution returned to the central command module"],
  [/\bpub async fn list_dashboards\b/, "dashboard list returned to the central command module"],
  [/\bpub async fn delete_dashboard\b/, "dashboard delete returned to the central command module"],
  [/\bpub async fn run_dashboard\b/, "dashboard execution returned to the central command module"],
]);
forbid("src-tauri/src/features/jobs/transport.rs", [
  [/\bsqlx\b/, "job transport must delegate instead of writing the ledger"],
  [/crate::store/, "job transport must not access the store directly"],
  [/crate::connection/, "job transport must not authorize connections directly"],
]);
forbid("src-tauri/src/features/erd/transport.rs", [
  [/\bsqlx\b/, "ERD transport must delegate instead of writing layouts"],
  [/crate::store/, "ERD transport must not access the store directly"],
  [/crate::connection/, "ERD transport must not authorize connections directly"],
]);
forbid("src-tauri/src/features/schema_editor/transport.rs", [
  [/SchemaService/, "schema-editor transport must delegate to the feature"],
  [/ScriptService/, "schema-editor transport must not call the script implementation"],
  [/CatalogFeature/, "schema-editor transport must not call the catalog implementation"],
  [/crate::ddl/, "schema-editor transport must not render DDL"],
]);
forbid("src-tauri/src/features/dashboards/transport.rs", [
  [/\bsqlx\b/, "dashboard transport must delegate instead of querying SQLite"],
  [/crate::store/, "dashboard transport must not read the store directly"],
  [/crate::connection/, "dashboard transport must not authorize connections directly"],
  [/crate::services/, "dashboard transport must not use a legacy service contract"],
]);
for (const filePath of walk("src-tauri/src/features/jobs/application")
  .filter((file) => file.endsWith(".rs"))
  .map(relative)) {
  forbid(filePath, [
    [/crate::connection/, "job application must authorize through its port"],
    [/crate::store/, "job application must persist through its ledger port"],
    [/\bsqlx\b/, "job application must not contain database adapter code"],
    [/super::adapters/, "job application must not depend on concrete adapters"],
    [/\bOperationRuntime\b/, "job application must use the Operation port"],
    [/\bCatalogFeature\b/, "job application must use the catalog port"],
    [/\bstd::fs\b/, "job application must use the file port"],
    [
      /tokio::task::spawn_blocking/,
      "job application must delegate blocking file work to an adapter",
    ],
  ]);
}
forbid("src-tauri/src/features/jobs/ports.rs", [
  [/crate::connection/, "job ports must not expose a concrete connection runtime"],
  [/crate::store/, "job ports must not expose concrete storage"],
  [/\bsqlx\b/, "job ports must not expose SQL adapter types"],
  [/\btauri\b/, "job ports must not expose transport types"],
]);
forbid("src-tauri/src/services/mod.rs", [
  [
    /\b(?:JobService|CreateJobRequest|JobDetail|JobFileCapability|JobFormat|JobInputInspection|JobProposal)\b/,
    "central service facade must not re-export feature-owned job contracts",
  ],
  [
    /\b(?:ErdService|SaveErdLayoutOutcome|SaveErdLayoutRequest)\b/,
    "central service facade must not re-export feature-owned ERD contracts",
  ],
  [
    /\b(?:SchemaService|SchemaChangePreviewRequest|SchemaChangeProposalReceipt)\b/,
    "central service facade must not re-export feature-owned schema-editor contracts",
  ],
  [
    /\b(?:DashboardService|DashboardRunRequest|DashboardRunReceipt|AgentDashboard)\b/,
    "central service facade must not re-export feature-owned dashboard contracts",
  ],
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
  "src-tauri/src/features/terminals/domain.rs",
  "src-tauri/src/features/terminals/ports.rs",
  "src-tauri/src/features/terminals/application.rs",
]) {
  requireFile(filePath);
  forbid(filePath, [
    [/\btauri\b/, "Terminal core must not depend on Tauri"],
    [/crate::store/, "Terminal core must not depend on the SQLite store"],
    [/crate::broker/, "Terminal core must not depend on the Broker runtime"],
  ]);
}
forbid("src-tauri/src/features/terminals/transport.rs", [
  [/crate::store/, "Terminal transport must delegate instead of reading the store"],
  [/crate::broker/, "Terminal transport must delegate instead of using the Broker"],
  [/crate::cli_install/, "Terminal transport must delegate CLI resolution to its adapter"],
  [/adapters::/, "Terminal transport must not depend on a concrete adapter"],
  [/\b(?:DesktopTerminalAdapter|PtyTerminalRuntime)\b/, "Terminal transport must delegate to the feature use cases"],
  [/\bportable_pty\b/, "Terminal transport must not create or control PTYs"],
]);

for (const filePath of [
  "src/features/connections/domain.ts",
  "src/features/jobs/domain.ts",
  "src/features/erd/domain.ts",
  "src/features/schemaEditor/domain.ts",
  "src/features/dashboards/domain.ts",
  "src/features/sqlDocuments/domain.ts",
  "src/features/terminals/domain.ts",
  "src/features/terminals/state.ts",
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
const jobCommands = [
  "pick_job_input",
  "pick_job_output",
  "inspect_job_input",
  "create_job",
  "list_jobs",
  "get_job",
  "start_job",
  "pause_job",
  "cancel_job",
  "reveal_job_artifact",
];
for (const command of jobCommands) {
  const owners = frontendSource
    .filter(([, source]) => source.includes(`"${command}"`))
    .map(([filePath]) => filePath);
  if (
    owners.length !== 1 ||
    owners[0] !== "src/features/jobs/tauriAdapter.ts"
  ) {
    fail(
      `${command}: expected only src/features/jobs/tauriAdapter.ts, found ${owners.join(", ") || "none"}`,
    );
  }
}
const erdCommands = [
  "list_erd_layouts",
  "save_erd_layout",
  "delete_erd_layout",
];
for (const command of erdCommands) {
  const owners = frontendSource
    .filter(([, source]) => source.includes(`"${command}"`))
    .map(([filePath]) => filePath);
  if (
    owners.length !== 1 ||
    owners[0] !== "src/features/erd/tauriAdapter.ts"
  ) {
    fail(
      `${command}: expected only src/features/erd/tauriAdapter.ts, found ${owners.join(", ") || "none"}`,
    );
  }
}
const schemaEditorCommands = [
  "preview_schema_change",
  "propose_schema_change",
  "run_schema_change",
];
for (const command of schemaEditorCommands) {
  const owners = frontendSource
    .filter(([, source]) => source.includes(`"${command}"`))
    .map(([filePath]) => filePath);
  if (
    owners.length !== 1 ||
    owners[0] !== "src/features/schemaEditor/tauriAdapter.ts"
  ) {
    fail(
      `${command}: expected only src/features/schemaEditor/tauriAdapter.ts, found ${owners.join(", ") || "none"}`,
    );
  }
}
const dashboardCommands = [
  "list_dashboards",
  "delete_dashboard",
  "run_dashboard",
];
for (const command of dashboardCommands) {
  const owners = frontendSource
    .filter(([, source]) => source.includes(`"${command}"`))
    .map(([filePath]) => filePath);
  if (
    owners.length !== 1 ||
    owners[0] !== "src/features/dashboards/tauriAdapter.ts"
  ) {
    fail(
      `${command}: expected only src/features/dashboards/tauriAdapter.ts, found ${owners.join(", ") || "none"}`,
    );
  }
}
const terminalCommands = [
  "terminal_create",
  "terminal_list",
  "terminal_focus",
  "terminal_write",
  "terminal_resize",
  "terminal_kill",
  "terminal_close",
  "terminal_restart",
  "terminal_rename",
  "terminal_shutdown_all",
];
for (const command of terminalCommands) {
  const owners = frontendSource
    .filter(
      ([, source]) =>
        source.includes(`"${command}"`) || source.includes(`'${command}'`),
    )
    .map(([filePath]) => filePath);
  if (
    owners.length !== 1 ||
    owners[0] !== "src/features/terminals/tauriAdapter.ts"
  ) {
    fail(
      `${command}: expected only src/features/terminals/tauriAdapter.ts, found ${owners.join(", ") || "none"}`,
    );
  }
}
const terminalContractTypes = [
  "TerminalSessionId",
  "TerminalProfile",
  "TerminalLifecycle",
  "TerminalDatabasePolicy",
  "TerminalSize",
  "TerminalCreateRequest",
  "TerminalConnectionPin",
  "TerminalExit",
  "TerminalSessionSummary",
  "TerminalOutputChunk",
  "TerminalFocusReceipt",
  "TerminalStateEvent",
  "TerminalExitEvent",
];
for (const typeName of terminalContractTypes) {
  const declaration = new RegExp(
    `^export\\s+(?:interface|type)\\s+${typeName}\\b`,
    "m",
  );
  const owners = frontendSource
    .filter(([, source]) => declaration.test(source))
    .map(([filePath]) => filePath);
  if (
    owners.length !== 1 ||
    owners[0] !== "src/features/terminals/domain.ts"
  ) {
    fail(
      `${typeName}: expected only src/features/terminals/domain.ts, found ${owners.join(", ") || "none"}`,
    );
  }
}
forbid("src/ipc/types.ts", [
  [/\binterface ConnectionProfile\b/, "connection profile returned to the central IPC type file"],
  [/\binterface DriverDescriptor\b/, "driver descriptor returned to the central IPC type file"],
  [/\binterface Workspace\b/, "workspace type returned to the central IPC type file"],
  [/\binterface WorkspaceAuth/, "workspace auth type returned to the central IPC type file"],
  [
    /\b(?:interface|type)\s+Job(?:Kind|Format|State|FileDirection|ErrorPolicy|FileCapability|InputInspection|FieldMapping|Validation|Plan|Proposal|Artifact|Detail|ChangedEvent)?\b/,
    "job contract returned to the central IPC type file",
  ],
  [/\binterface CreateJobRequest\b/, "job request returned to the central IPC type file"],
  [
    /\b(?:interface|type)\s+Erd(?:Layout|LayoutMode|NodePosition|Viewport|CanvasLayout|VirtualRelation)\b/,
    "ERD contract returned to the central IPC type file",
  ],
  [/\binterface SaveErdLayout/, "ERD request/outcome returned to the central IPC type file"],
  [
    /\b(?:interface|type)\s+(?:DdlColumnDefinition|DdlDefaultChange|DdlColumnAlteration|SchemaChange|SchemaChangeRequest|DdlPlan|SchemaChangeProposal)\b/,
    "schema-editor contract returned to the central IPC type file",
  ],
  [
    /\b(?:interface|type)\s+Dashboard(?:Kind|Visualization)?\b/,
    "dashboard contract returned to the central IPC type file",
  ],
  [
    /\b(?:interface|type)\s+Terminal(?:SessionId|CreateRequest|FocusReceipt|OutputChunk|SessionSummary|Size|ConnectionPin|Exit|StateEvent|ExitEvent|Profile|Lifecycle|DatabasePolicy)\b/,
    "Terminal contract returned to the central IPC type file",
  ],
]);
forbid("src/ipc/commands.ts", [
  [/\bfunction listConnections\b/, "connection commands returned to the central IPC facade"],
  [/\bfunction upsertConnection\b/, "connection commands returned to the central IPC facade"],
  [/\bfunction deleteConnection\b/, "connection commands returned to the central IPC facade"],
  [/\bfunction listWorkspaces\b/, "workspace commands returned to the central IPC facade"],
  [/\bfunction workspaceAuthState\b/, "workspace auth returned to the central IPC facade"],
  [/\bfunction setActiveWorkspace\b/, "workspace selection returned to the central IPC facade"],
  [
    /\b(?:pickJobInput|pickJobOutput|inspectJobInput|createJob|listJobs|getJob|startJob|pauseJob|cancelJob|revealJobArtifact)\b/,
    "job commands returned to the central IPC facade",
  ],
  [
    /\b(?:listErdLayouts|saveErdLayout|deleteErdLayout)\b/,
    "ERD commands returned to the central IPC facade",
  ],
  [
    /\b(?:previewSchemaChange|proposeSchemaChange|runSchemaChange)\b/,
    "schema-editor commands returned to the central IPC facade",
  ],
  [
    /\b(?:listDashboards|deleteDashboard|runDashboard)\b/,
    "dashboard commands returned to the central IPC facade",
  ],
  [
    /\b(?:terminalOutputChannel|terminalCreate|terminalList|terminalFocus|terminalWrite|terminalResize|terminalKill|terminalClose|terminalRestart|terminalRename|terminalShutdownAll)\b/,
    "Terminal commands returned to the central IPC facade",
  ],
]);
for (const [filePath, source] of frontendSource) {
  if (
    /import\s+type\s*\{[^}]*\bConnectionProfile\b[^}]*\}\s*from\s*["'][^"']*ipc\/types["']/.test(
      source,
    )
  ) {
    fail(`${filePath}: imports ConnectionProfile from the removed central owner`);
  }
  if (
    /import\s+type\s*\{[^}]*\bTerminal(?:SessionId|CreateRequest|FocusReceipt|OutputChunk|SessionSummary|Size|ConnectionPin|Exit|StateEvent|ExitEvent|Profile|Lifecycle|DatabasePolicy)\b[^}]*\}\s*from\s*["'][^"']*ipc\/types["']/.test(
      source,
    )
  ) {
    fail(`${filePath}: imports a Terminal contract from the removed central owner`);
  }
  if (
    /import\s*\{[^}]*\bterminal(?:OutputChannel|Create|List|Focus|Write|Resize|Kill|Close|Restart|Rename|ShutdownAll)\b[^}]*\}\s*from\s*["'][^"']*ipc\/commands["']/.test(
      source,
    )
  ) {
    fail(`${filePath}: imports a Terminal command from the removed central owner`);
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
