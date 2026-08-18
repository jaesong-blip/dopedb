// Executes the split architecture guards as one CI contract. The collectors own
// their domain rules; this file only supplies a deterministic repository view.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRuntimeDependencyGraph,
  collectDependencyParserSelfDiagnostics,
  findDependencyPath,
} from "./architecture/dependency-graph.mjs";
import { collectFrontendDependencyCycleDiagnostics } from "./architecture/frontend-dependency-cycles.mjs";
import { collectProviderOwnershipDiagnostics } from "./architecture/provider-ownership.mjs";
import { collectQueryCentralIpcDiagnostics } from "./architecture/query-central-ipc-ownership.mjs";
import { collectQueryFrontendOwnershipDiagnostics } from "./architecture/query-frontend-ownership.mjs";
import { collectRepositoryIdentityDiagnostics } from "./architecture/repository-identity-guards.mjs";
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

function readTextFile(file) {
  // Architecture markers describe source structure, not checkout line endings.
  return fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
}

function read(relativePath) {
  return readTextFile(path.join(root, relativePath));
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
  .map((file) => [relative(file), readTextFile(file)]);
const frontendProductionSource = frontendSource
  .filter(([filePath]) => !/\.(?:test|spec)\.[^.]+$/.test(filePath));
const rustSource = sourceFiles
  .filter((file) => file.endsWith(".rs"))
  .map((file) => readTextFile(file))
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

// The state ownership catalog is an executable architecture contract, not an
// aspirational document. Every owner/dispatcher and reviewed writer marker must
// exist, while retired competing writer shapes stay absent from production.
const stateOwnershipPath = "docs/architecture/state-ownership.json";
const stateOwnership = JSON.parse(read(stateOwnershipPath));
const stateOwnershipSource = [
  ...sourceFiles.map(relative),
  ...walk("workspace-cloud/app").map(relative),
  ...walk("workspace-cloud/features").map(relative),
  ...walk("workspace-cloud/lib").map(relative),
]
  .filter((filePath, index, files) => (
    /\.(?:rs|ts|tsx)$/.test(filePath)
    && !/\.(?:test|spec)\.[^.]+$/.test(filePath)
    && files.indexOf(filePath) === index
  ))
  .map((filePath) => [filePath, read(filePath)]);

// Literal enum boundaries must never coerce arrays or objects into an accepted
// string. The only reviewed String-to-membership conversions normalize GCP's
// loosely typed database flag values into a boolean and never return authority.
const reviewedBooleanStringMembership = new Map([
  [
    "workspace-cloud/lib/providers/gcp-cloud-oauth.ts",
    '["on", "true", "1"].includes(String(item.value).toLowerCase())',
  ],
  [
    "workspace-cloud/lib/providers/gcp-cloud-sql.ts",
    '["on", "true", "1"].includes(String(flag.value).toLowerCase())',
  ],
]);
for (const [filePath, source] of stateOwnershipSource.filter(
  ([candidate]) => candidate.startsWith("workspace-cloud/"),
)) {
  let unreviewedSource = source;
  const reviewedExpression = reviewedBooleanStringMembership.get(filePath);
  if (reviewedExpression && unreviewedSource.includes(reviewedExpression)) {
    unreviewedSource = unreviewedSource.replace(reviewedExpression, "");
  }
  if (/\.includes\s*\(\s*String\s*\(/.test(unreviewedSource)) {
    failures.push(
      `${filePath}: literal membership must reject non-strings before comparison; String coercion is reserved for the reviewed GCP boolean flag normalization`,
    );
  }
}
const ownershipNames = new Set();
for (const state of [...stateOwnership.states, ...stateOwnership.runtimeStates]) {
  if (ownershipNames.has(state.name)) {
    failures.push(`${stateOwnershipPath}: duplicate state owner name (${state.name})`);
  }
  ownershipNames.add(state.name);
  if (!exists(state.owner)) {
    failures.push(`${stateOwnershipPath}: ${state.name} owner is missing (${state.owner})`);
  }
  if (state.dispatcher && !exists(state.dispatcher)) {
    failures.push(
      `${stateOwnershipPath}: ${state.name} dispatcher is missing (${state.dispatcher})`,
    );
  }
  const ownerSource = exists(state.owner) ? read(state.owner) : "";
  for (const token of state.writerTokens ?? []) {
    if (!ownerSource.includes(token)) {
      failures.push(
        `${stateOwnershipPath}: ${state.name} owner writer marker is stale (${token})`,
      );
    }
  }
  for (const token of state.forbiddenWriterTokens ?? []) {
    const offender = stateOwnershipSource.find(([, source]) => source.includes(token));
    if (offender) {
      failures.push(`${offender[0]}: competing ${state.name} state writer returned (${token})`);
    }
  }
}

for (const workflow of walk(".github/workflows").filter((file) => /\.ya?ml$/.test(file))) {
  const filePath = relative(workflow);
  for (const match of read(filePath).matchAll(/\buses:\s+([^\s#]+)/g)) {
    const action = match[1];
    if (!action.startsWith("./") && !/@[0-9a-f]{40}$/.test(action)) {
      failures.push(`${filePath}: third-party action must use an immutable full commit SHA (${action})`);
    }
  }
}

failures.push(...collectDependencyParserSelfDiagnostics());
for (const collect of [
  collectProviderOwnershipDiagnostics,
  collectRepositoryIdentityDiagnostics,
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
failures.push(...collectFrontendDependencyCycleDiagnostics(context));

const {
  graph: frontendRuntimeDependencyGraph,
  specifiers: frontendRuntimeSpecifiers,
} = buildRuntimeDependencyGraph(frontendProductionSource, {
  includeDynamic: true,
});

// Screens are composition leaves. Feature code may not reach back into a
// screen-owned implementation. Only these reviewed AppShell files compose them.
const screenCompositionRoots = new Set([
  "src/features/appShell/ShellLayout.tsx",
  "src/features/appShell/WorkbenchContent.tsx",
]);
const appShellCompositionRoot = "src/features/appShell/AppShell.tsx";
for (const [importer, dependencies] of frontendRuntimeDependencyGraph) {
  if (importer === appShellCompositionRoot) continue;
  for (const compositionRoot of screenCompositionRoots) {
    if (dependencies.includes(compositionRoot)) {
      failures.push(
        `${importer}: only ${appShellCompositionRoot} may import the reviewed screen composition root (${compositionRoot})`,
      );
    }
  }
}
const screenOwnershipDependencyGraph = new Map(frontendRuntimeDependencyGraph);
for (const compositionRoot of screenCompositionRoots) {
  // The boundary is allowed to compose screens; callers depend on that boundary,
  // not on its screen implementation details.
  screenOwnershipDependencyGraph.set(compositionRoot, []);
}
for (const [filePath] of frontendProductionSource) {
  if (!filePath.startsWith("src/features/") || screenCompositionRoots.has(filePath)) {
    continue;
  }
  const screenPath = findDependencyPath(
    screenOwnershipDependencyGraph,
    filePath,
    (dependency) => dependency.startsWith("src/screens/"),
  );
  if (screenPath) {
    failures.push(
      `${filePath}: feature code must not reach a screen-owned module (${screenPath.join(" -> ")})`,
    );
  }
}

// Generic presentation layers stay runtime-agnostic. Domain-aware data hooks
// and Tauri command adapters belong to feature-owned modules composed above them.
// Walk every local runtime edge so an intermediate helper cannot hide ownership.
const genericRuntimeProbe = buildRuntimeDependencyGraph([
  [
    "src/components/probe.ts",
    'export { probe } from "./probe-helper"',
  ],
  [
    "src/components/probe-helper.ts",
    'export const probe = () => import("@tauri-apps/api/core")',
  ],
  [
    "src/components/probe-negative.ts",
    'import type { invoke } from "@tauri-apps/api/core"',
  ],
], { includeDynamic: true });
const genericTauriProbePath = findDependencyPath(
  genericRuntimeProbe.graph,
  "src/components/probe.ts",
  (dependency) => (genericRuntimeProbe.specifiers.get(dependency) ?? []).some(
    (specifier) => /^@tauri-apps(?:\/|$)/.test(specifier),
  ),
);
if (
  genericTauriProbePath?.join(" -> ")
    !== "src/components/probe.ts -> src/components/probe-helper.ts"
  || findDependencyPath(
    genericRuntimeProbe.graph,
    "src/components/probe-negative.ts",
    (dependency) => (genericRuntimeProbe.specifiers.get(dependency) ?? []).some(
      (specifier) => /^@tauri-apps(?:\/|$)/.test(specifier),
    ),
  ) !== null
) {
  failures.push("generic presentation Tauri runtime guard self-test failed");
}
for (const [filePath] of frontendProductionSource) {
  if (
    !filePath.startsWith("src/components/")
    && !filePath.startsWith("src/design-system/")
  ) {
    continue;
  }
  const tanstackPath = findDependencyPath(
    frontendRuntimeDependencyGraph,
    filePath,
    (dependency) => (frontendRuntimeSpecifiers.get(dependency) ?? []).some(
      (specifier) => (
        specifier === "@tanstack/react-query"
        || specifier.startsWith("@tanstack/react-query/")
      ),
    ),
  );
  if (tanstackPath) {
    failures.push(
      `${filePath}: generic presentation runtime must not reach @tanstack/react-query (${[
        ...tanstackPath,
        "@tanstack/react-query",
      ].join(" -> ")})`,
    );
  }
  const tauriRuntimePath = findDependencyPath(
    frontendRuntimeDependencyGraph,
    filePath,
    (dependency) => (frontendRuntimeSpecifiers.get(dependency) ?? []).some(
      (specifier) => /^@tauri-apps(?:\/|$)/.test(specifier),
    ),
  );
  if (tauriRuntimePath) {
    failures.push(
      `${filePath}: generic presentation runtime must not reach @tauri-apps (${[
        ...tauriRuntimePath,
        "@tauri-apps/*",
      ].join(" -> ")})`,
    );
  }
  const tauriAdapterPath = findDependencyPath(
    frontendRuntimeDependencyGraph,
    filePath,
    (dependency) => (
      dependency.startsWith("src/features/")
      && /\/tauriAdapter(?:\.[^/]+|\/)/.test(dependency)
    ),
  );
  if (tauriAdapterPath) {
    failures.push(
      `${filePath}: generic presentation runtime must not reach a feature Tauri adapter (${tauriAdapterPath.join(" -> ")})`,
    );
  }
}

const workbenchContent = read("src/features/appShell/WorkbenchContent.tsx");
const coldWorkbenchScreens = [
  "Activity",
  "Connections/ConnectionForm",
  "Documents",
  "Knowledge",
  "Schema",
  "SchemaDiff",
  "Settings",
  "Sql",
  "Tables",
];
for (const screen of coldWorkbenchScreens) {
  if (new RegExp(`^import\\s+[^;]+["']\\.\\.\\/\\.\\.\\/screens\\/${screen}["']`, "m").test(workbenchContent)) {
    failures.push(
      `src/features/appShell/WorkbenchContent.tsx: cold screen ${screen} must load through React.lazy`,
    );
  }
}
if (!/\blazy\s*\(/.test(workbenchContent) || !/\bSuspense\b/.test(workbenchContent)) {
  failures.push(
    "src/features/appShell/WorkbenchContent.tsx: cold workbench screens need one Suspense loading boundary",
  );
}

// AppShell is a composition root, not the owner of connection/query workflows
// or Action Search catalog assembly. Its two large presentation children
// receive grouped model/command contracts rather than rebuilding scalar bags.
const appShellPath = "src/features/appShell/AppShell.tsx";
const shellLayoutPath = "src/features/appShell/ShellLayout.tsx";
const workbenchControllerPath =
  "src/features/appShell/useAppShellWorkbenchController.ts";
const searchItemsPath =
  "src/features/actionSearch/useActionSearchItems.ts";
const appShellSource = read(appShellPath);
for (const [filePath, limit] of [
  [appShellPath, 520],
  [workbenchControllerPath, 550],
  [searchItemsPath, 260],
]) {
  const lines = lineCount(read(filePath));
  if (lines > limit) {
    failures.push(
      `${filePath}: AppShell boundary has ${lines} lines; keep it below ${limit}`,
    );
  }
}
for (const [pattern, responsibility] of [
  [/@tanstack\/react-query/, "TanStack Query ownership"],
  [/tauriAdapter/, "direct Tauri adapter ownership"],
  [/\bdatabaseCatalogQuery\b|\bdriversQuery\b/, "catalog query assembly"],
  [/\buseConnectionProfiles\b|\buseWorkbenchDocuments\b|\buseSafetySettings\b/, "connection/workbench state ownership"],
  [/\buseCachedCatalogOverviews\b|\bfilterCatalogOverview\b/, "Action Search catalog ownership"],
]) {
  if (pattern.test(appShellSource)) {
    failures.push(`${appShellPath}: composition root regained ${responsibility}`);
  }
}
for (const [component, source, filePath] of [
  ["ShellLayout", read(shellLayoutPath), shellLayoutPath],
  ["WorkbenchContent", workbenchContent, "src/features/appShell/WorkbenchContent.tsx"],
]) {
  const propsBlock = source.match(/type Props = \{(?<body>[\s\S]*?)\n\};/)?.groups?.body ?? "";
  const topLevelProps = [...propsBlock.matchAll(/^  ([A-Za-z][A-Za-z0-9]*):/gm)]
    .map((match) => match[1]);
  if (topLevelProps.join(",") !== "model,commands") {
    failures.push(
      `${filePath}: ${component} must expose only grouped model and commands props`,
    );
  }
  if (/@tanstack\/react-query|tauriAdapter/.test(source)) {
    failures.push(
      `${filePath}: grouped AppShell presentation must not own query or adapter effects`,
    );
  }
}
for (const component of ["ShellLayout", "WorkbenchContent"]) {
  const opening = appShellSource.match(
    new RegExp(`<${component}\\n(?<body>[\\s\\S]*?)\\n\\s*/>`),
  )?.groups?.body ?? "";
  const indentation = component === "ShellLayout" ? 8 : 6;
  const attributes = [...opening.matchAll(
    new RegExp(`^ {${indentation}}([A-Za-z][A-Za-z0-9]*)=`, "gm"),
  )].map((match) => match[1]);
  if (attributes.join(",") !== "model,commands") {
    failures.push(
      `${appShellPath}: ${component} call must pass only grouped model and commands (${attributes.join(", ") || "none"})`,
    );
  }
}
for (const token of [
  "useAppShellWorkbenchController",
  "useActionSearchItems",
  "useActionSearchDialog",
]) {
  if (!appShellSource.includes(token)) {
    failures.push(`${appShellPath}: bounded shell controller marker lost (${token})`);
  }
}
for (const token of [
  "<RenderRecoveryBoundary",
  "resetKeys={[focus.requestId]}",
  "<KnowledgeRecovery onRetry={retry}",
]) {
  if (!workbenchContent.includes(token)) {
    failures.push(
      `src/features/appShell/WorkbenchContent.tsx: Knowledge surface recovery boundary lost (${token})`,
    );
  }
}

// These migrated screens are presentation leaves. Their feature controllers own
// server cache, IPC commands, streaming, and mutation workflows; keep both sides
// below the reviewed size ratchet so responsibility cannot silently flow back.
for (const boundary of [
  {
    view: "src/screens/Connections/ConnectionForm.tsx",
    viewLimit: 180,
    controller: "src/features/connections/useConnectionEditorController.ts",
    controllerLimit: 120,
  },
  {
    view: "src/screens/Sql/index.tsx",
    viewLimit: 500,
    controller: "src/features/queries/useSqlWorkbenchController.ts",
    controllerLimit: 950,
  },
  {
    view: "src/screens/Knowledge/AnalysisArticles.tsx",
    viewLimit: 900,
    controller: "src/features/analysisArticles/useAnalysisArticlesController.ts",
    controllerLimit: 500,
  },
]) {
  for (const [filePath, limit] of [
    [boundary.view, boundary.viewLimit],
    [boundary.controller, boundary.controllerLimit],
  ]) {
    const lines = lineCount(read(filePath));
    if (lines > limit) {
      failures.push(`${filePath}: workflow boundary has ${lines} lines; keep it below ${limit}`);
    }
  }
  const viewSource = read(boundary.view);
  for (const [pattern, responsibility] of [
    [/@tanstack\/react-query/, "TanStack Query ownership"],
    [/tauriAdapter/, "direct IPC adapter ownership"],
    [/\buseSqlResultStream\b/, "query stream ownership"],
  ]) {
    if (pattern.test(viewSource)) {
      failures.push(`${boundary.view}: presentation regained ${responsibility}`);
    }
  }
}

// Connection editing keeps catalog, profile lifecycle, and schema discovery in
// separate feature controllers. The screen root and its presentation leaves
// consume only the grouped projection; they never regain cache or IPC ownership.
const connectionEditorBoundaries = [
  ["src/screens/Connections/ConnectionAdvancedTab.tsx", 150],
  ["src/screens/Connections/ConnectionCatalogCompactSelector.tsx", 120],
  ["src/screens/Connections/ConnectionCatalogDetail.tsx", 220],
  ["src/screens/Connections/ConnectionCatalogNavigation.tsx", 600],
  ["src/screens/Connections/ConnectionEditorDialogs.tsx", 80],
  ["src/screens/Connections/ConnectionEditorFooter.tsx", 100],
  ["src/screens/Connections/ConnectionGeneralTab.tsx", 450],
  ["src/screens/Connections/ConnectionOptionsTab.tsx", 350],
  ["src/screens/Connections/ConnectionProfilePanel.tsx", 180],
  ["src/screens/Connections/ConnectionSchemaTab.tsx", 220],
  ["src/screens/Connections/ConnectionSecurityTab.tsx", 260],
  ["src/features/connections/connectionEditorModel.ts", 300],
  ["src/features/connections/useConnectionCatalogController.ts", 450],
  ["src/features/connections/useConnectionEditorDialogs.ts", 100],
  ["src/features/connections/useConnectionProfileController.ts", 500],
  ["src/features/connections/useConnectionProfileState.ts", 400],
  ["src/features/connections/useConnectionSchemaController.ts", 150],
];
for (const [filePath, limit] of connectionEditorBoundaries) {
  const lines = lineCount(read(filePath));
  if (lines > limit) {
    failures.push(
      `${filePath}: Connection editor boundary has ${lines} lines; keep it below ${limit}`,
    );
  }
}
for (const [filePath] of connectionEditorBoundaries.filter(
  ([candidate]) => candidate.startsWith("src/screens/Connections/"),
)) {
  const source = read(filePath);
  for (const [pattern, responsibility] of [
    [/@tanstack\/react-query|\.\.\/\.\.\/lib\/queries/, "TanStack Query ownership"],
    [/tauriAdapter|@tauri-apps(?:\/|\b)/, "Tauri adapter ownership"],
    [/\.(?:query|discovery)\b/, "raw async-result shape"],
  ]) {
    if (pattern.test(source)) {
      failures.push(
        `${filePath}: Connection presentation regained ${responsibility}`,
      );
    }
  }
}
const connectionEditorController = read(
  "src/features/connections/useConnectionEditorController.ts",
);
for (const token of [
  "profile: profileController.view",
  "catalog: catalog.view",
  "schema,",
  "dialogs:",
  "commands: profileController.commands",
]) {
  if (!connectionEditorController.includes(token)) {
    failures.push(
      `src/features/connections/useConnectionEditorController.ts: grouped Connection editor contract lost ${token}`,
    );
  }
}
for (const token of ["driverCatalog", "discovery"]) {
  if (connectionEditorController.includes(token)) {
    failures.push(
      `src/features/connections/useConnectionEditorController.ts: raw controller state escaped the grouped projection (${token})`,
    );
  }
}

// AI Chat keeps protocol/session state in one feature controller, while the
// panel, transcript, and composer remain bounded presentation leaves. The
// grouped controller contract also keeps stale focus generations beside the
// commands that can race them rather than leaking adapter calls into JSX.
const acpChatBoundaries = [
  ["src/features/agents/AcpChatPanel.tsx", 400],
  ["src/features/agents/AcpChatTranscript.tsx", 700],
  ["src/features/agents/AcpChatComposer.tsx", 350],
  ["src/features/agents/useAcpChatController.ts", 850],
  ["src/features/agents/acpTranscriptPresentation.ts", 350],
  ["src/features/agents/acpPromptContext.ts", 150],
];
for (const [filePath, limit] of acpChatBoundaries) {
  const lines = lineCount(read(filePath));
  if (lines > limit) {
    failures.push(
      `${filePath}: ACP Chat boundary has ${lines} lines; keep it below ${limit}`,
    );
  }
}
for (const filePath of [
  "src/features/agents/AcpChatPanel.tsx",
  "src/features/agents/AcpChatTranscript.tsx",
  "src/features/agents/AcpChatComposer.tsx",
  "src/features/agents/acpTranscriptPresentation.ts",
  "src/features/agents/acpPromptContext.ts",
]) {
  const source = read(filePath);
  for (const [pattern, responsibility] of [
    [/@tanstack\/react-query|\buseQuery\b/, "TanStack Query ownership"],
    [/tauriAdapter/, "direct IPC adapter ownership"],
    [/sessionStore|sessionFocus/, "ACP session/focus store ownership"],
    [/@tauri-apps(?:\/|\b)/, "Tauri runtime effect ownership"],
  ]) {
    if (pattern.test(source)) {
      failures.push(`${filePath}: ACP presentation regained ${responsibility}`);
    }
  }
}
const acpChatPanel = read("src/features/agents/AcpChatPanel.tsx");
for (const token of [
  "useAcpChatController",
  "<AcpChatTranscript",
  "<AcpChatComposer",
]) {
  if (!acpChatPanel.includes(token)) {
    failures.push(
      `src/features/agents/AcpChatPanel.tsx: ACP composition boundary lost ${token}`,
    );
  }
}
const acpChatController = read(
  "src/features/agents/useAcpChatController.ts",
);
for (const token of [
  "selectionGenerationRef",
  "focusRequestIdRef",
  "isCurrentAcpFocusRequest",
  "useAcpSessionSnapshot",
  "createFrameCoalescer",
  "visibleAcpTranscriptItems",
  "viewport:",
  "session:",
  "setup:",
  "composer:",
  "commands:",
]) {
  if (!acpChatController.includes(token)) {
    failures.push(
      `src/features/agents/useAcpChatController.ts: ACP controller lost owned boundary marker (${token})`,
    );
  }
}
const acpTranscriptPresentation = read(
  "src/features/agents/acpTranscriptPresentation.ts",
);
for (const token of [
  "selectRichTranscriptKeys",
  "findAnalysisArticle",
  "progressActivityLabel",
  "toolActivityLabel",
]) {
  if (!acpTranscriptPresentation.includes(token)) {
    failures.push(
      `src/features/agents/acpTranscriptPresentation.ts: transcript presentation lost ${token}`,
    );
  }
}

for (const [filePath, limit] of [
  ["workspace-cloud/app/settings/AnalysisManagementPanel.tsx", 60],
  ["workspace-cloud/features/analysisManagement/AnalysisManagementView.tsx", 400],
  ["workspace-cloud/features/providerAccess/NeonBranchManager.tsx", 750],
  ["workspace-cloud/features/providerAccess/useProviderAccountAccess.ts", 240],
  ["workspace-cloud/features/providerAccess/useSharedDatabaseAccess.ts", 600],
  ["workspace-cloud/features/providerAccess/transport.ts", 80],
  ["site/app/page.tsx", 200],
]) {
  const lines = lineCount(read(filePath));
  if (lines > limit) {
    failures.push(`${filePath}: presentation boundary has ${lines} lines; keep it below ${limit}`);
  }
}
for (const filePath of [
  "workspace-cloud/app/settings/AnalysisManagementPanel.tsx",
  "workspace-cloud/app/settings/CloudAccountPanel.tsx",
  "workspace-cloud/app/settings/SharedDatabasePanel.tsx",
  "workspace-cloud/features/analysisManagement/AnalysisManagementView.tsx",
  "workspace-cloud/features/providerAccess/NeonBranchManager.tsx",
]) {
  if (/\bfetch\s*\(/.test(read(filePath))) {
    failures.push(`${filePath}: presentation must call its feature controller rather than fetch directly`);
  }
}

// Account integration setup and shared database import are separate browser
// workflows. A connection-inventory outage must not take Cloud Accounts down,
// and GCP/account mutations must not flow back into the database controller.
const providerAccountControllerPath =
  "workspace-cloud/features/providerAccess/useProviderAccountAccess.ts";
const sharedDatabaseControllerPath =
  "workspace-cloud/features/providerAccess/useSharedDatabaseAccess.ts";
const cloudAccountPanelPath = "workspace-cloud/app/settings/CloudAccountPanel.tsx";
const sharedDatabasePanelPath = "workspace-cloud/app/settings/SharedDatabasePanel.tsx";
if (exists("workspace-cloud/features/providerAccess/useProviderAccess.ts")) {
  failures.push(
    "workspace-cloud/features/providerAccess/useProviderAccess.ts: account and database"
      + " workflows must not share an umbrella controller",
  );
}
for (const [filePath, requiredToken, forbiddenTokens] of [
  [
    cloudAccountPanelPath,
    "useProviderAccountAccess(workspaceId, gcpSetupId)",
    ["useSharedDatabaseAccess", "useProviderAccess("],
  ],
  [
    sharedDatabasePanelPath,
    "useSharedDatabaseAccess(workspaceId, initialIntegrationId)",
    ["useProviderAccountAccess", "useProviderAccess("],
  ],
]) {
  const source = read(filePath);
  if (!source.includes(requiredToken)) {
    failures.push(`${filePath}: panel must retain its dedicated access controller (${requiredToken})`);
  }
  for (const token of forbiddenTokens) {
    if (source.includes(token)) {
      failures.push(`${filePath}: panel crossed provider-access controller boundaries (${token})`);
    }
  }
}
for (const [filePath, forbiddenTokens] of [
  [providerAccountControllerPath, [
    "/connections",
    "fetchSharedConnectionsSnapshot",
    "useNeonProviderBootstrap",
    "deleteSharedConnection",
    "importDiscoveredResource",
  ]],
  [sharedDatabaseControllerPath, [
    "useGcpProviderSetup",
    "gcpSetupId",
    "beginConnect",
    "function connect(",
    "function disconnect(",
  ]],
]) {
  const source = read(filePath);
  if (!source.includes("useProviderAccessState()")) {
    failures.push(`${filePath}: controller must own an independent provider-access reducer instance`);
  }
  for (const token of forbiddenTokens) {
    if (source.includes(token)) {
      failures.push(`${filePath}: controller regained another workflow responsibility (${token})`);
    }
  }
}

const providerAccessTransportPath =
  "workspace-cloud/features/providerAccess/transport.ts";
const providerAccessStatePath =
  "workspace-cloud/features/providerAccess/state.ts";
const providerIntegrationListPath =
  "workspace-cloud/features/providerAccess/ProviderIntegrationList.tsx";
const providerIntegrationRoutePath =
  "workspace-cloud/app/api/v1/workspaces/[workspaceId]/provider-integrations/route.ts";
const providerAccessTransport = read(providerAccessTransportPath);
for (const token of [
  'includeManagedConnections ? "?includeManagedConnections=1" : ""',
  "fetchProviderAccessSnapshot(workspaceId, false, signal)",
  "fetchProviderAccessSnapshot(workspaceId, true, signal)",
]) {
  if (!providerAccessTransport.includes(token)) {
    failures.push(
      `${providerAccessTransportPath}: provider core and managed-inventory requests lost their explicit split (${token})`,
    );
  }
}
const providerIntegrationRoute = read(providerIntegrationRoutePath);
const providerIntegrationGet = providerIntegrationRoute.match(
  /export async function GET[\s\S]*?\n}\n\nexport async function POST/,
)?.[0] ?? "";
for (const token of [
  'searchParams.get(\n    "includeManagedConnections",\n  ) === "1"',
  "const managedRows = includeManagedConnections\n    ? await db.select({",
  "...(includeManagedConnections ? { managedConnections } : {}),",
]) {
  if (!providerIntegrationGet.includes(token)) {
    failures.push(
      `${providerIntegrationRoutePath}: core provider GET must gate managed connection inventory (${token})`,
    );
  }
}
if (providerIntegrationGet.includes("Promise.all([")) {
  failures.push(
    `${providerIntegrationRoutePath}: core provider GET must finish independently of managed connection inventory`,
  );
}
const providerAccountController = read(providerAccountControllerPath);
const accountCoreLoaded = providerAccountController.indexOf(
  "setIntegrations(data.integrations);",
);
const accountLoadingFinished = providerAccountController.indexOf(
  "setLoading(false);",
  accountCoreLoaded,
);
const accountInventoryEnrichment = providerAccountController.indexOf(
  "await fetchProviderAccessWithManagedConnections(",
  accountCoreLoaded,
);
if (
  accountCoreLoaded < 0
  || accountLoadingFinished < accountCoreLoaded
  || accountInventoryEnrichment < accountLoadingFinished
) {
  failures.push(
    `${providerAccountControllerPath}: account core must render before optional managed-inventory enrichment`,
  );
}
const accountInventoryBlock = providerAccountController.slice(
  accountInventoryEnrichment,
  providerAccountController.indexOf("\n  }, [", accountInventoryEnrichment),
);
if (
  !accountInventoryBlock.includes("inventory.response?.ok")
  || accountInventoryBlock.includes("setError(")
) {
  failures.push(
    `${providerAccountControllerPath}: managed-inventory enrichment must be optional and preserve account success`,
  );
}
if (
  !read(sharedDatabaseControllerPath).includes(
    "fetchProviderAccessWithManagedConnections(workspaceId, signal)",
  )
) {
  failures.push(
    `${sharedDatabaseControllerPath}: shared databases require the managed connection inventory request`,
  );
}
const providerAccessState = read(providerAccessStatePath);
const providerIntegrationList = read(providerIntegrationListPath);
for (const [source, filePath, token] of [
  [providerAccessState, providerAccessStatePath, "managedConnectionsLoaded: false"],
  [providerAccountController, providerAccountControllerPath, "managedConnectionsLoaded,"],
  [providerIntegrationList, providerIntegrationListPath, "copy.databasesUnavailable"],
]) {
  if (!source.includes(token)) {
    failures.push(
      `${filePath}: unavailable managed-inventory state must not render as a zero count (${token})`,
    );
  }
}

// Knowledge owns feature ports plus SQLite/hosted adapters. The facade and its
// consumers name only ports; raw Store and reqwest ownership stop at their
// corresponding adapters.
const knowledgeAdapterDirectory =
  "src-tauri/src/features/knowledge/adapters";
const knowledgeCompositionPath = "src-tauri/src/features/knowledge/mod.rs";
const knowledgeComposition = read(knowledgeCompositionPath);
for (const moduleName of ["adapters", "ports", "runtime_adapter"]) {
  const declarations = [...knowledgeComposition.matchAll(
    new RegExp(`^(?<visibility>\\s*pub(?:\\([^)]*\\))?\\s+)?mod\\s+${moduleName}\\s*;`, "gm"),
  )];
  if (declarations.length !== 1 || declarations[0].groups?.visibility) {
    failures.push(
      `${knowledgeCompositionPath}: ${moduleName} must remain a private production module`,
    );
  }
}
if (!knowledgeComposition.includes(
  "pub(crate) use adapters::local::LocalFolderAdapter;",
)) {
  failures.push(
    `${knowledgeCompositionPath}: AppState may receive LocalFolderAdapter only through its narrow root re-export`,
  );
}
if (
  !/pub\(crate\) fn compose\(store: crate::store::Store\) -> KnowledgeFeature/.test(
    knowledgeComposition,
  )
  || !knowledgeComposition.includes(
    "adapters::SqliteKnowledgeRepository::new(store)",
  )
) {
  failures.push(
    `${knowledgeCompositionPath}: production composition must construct concrete Knowledge adapters behind compose(store)`,
  );
}
if (!/#\[cfg\(test\)\]\s*pub\(crate\) mod test_support/.test(knowledgeComposition)) {
  failures.push(
    `${knowledgeCompositionPath}: concrete Knowledge test access must remain cfg(test)-only`,
  );
}
function rustArchitectureTokens(source) {
  const tokens = [];
  let cursor = 0;
  const push = (value) => tokens.push({ start: cursor, value });
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      cursor += 2;
      while (cursor < source.length && !/[\r\n]/.test(source[cursor])) cursor += 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      cursor += 2;
      let depth = 1;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      continue;
    }
    const rawString = source.slice(cursor).match(/^(?:b|c)?r(#{0,255})"/);
    if (rawString) {
      const terminator = `"${rawString[1]}`;
      cursor += rawString[0].length;
      const close = source.indexOf(terminator, cursor);
      cursor = close < 0 ? source.length : close + terminator.length;
      continue;
    }
    const quoteOffset = (
      ["b", "c"].includes(source[cursor])
      && ["\"", "'"].includes(source[cursor + 1])
    ) ? 1 : 0;
    const quote = source[cursor + quoteOffset];
    if (quote === "\"" || (
      quote === "'"
      && source.slice(cursor + quoteOffset + 1).match(/^(?:\\.|[^'\r\n])'/)
    )) {
      cursor += quoteOffset + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2;
        } else if (source[cursor] === quote) {
          cursor += 1;
          break;
        } else {
          cursor += 1;
        }
      }
      continue;
    }
    if (/[A-Za-z_]/.test(source[cursor])) {
      const start = cursor;
      cursor += 1;
      while (/[A-Za-z0-9_]/.test(source[cursor] ?? "")) cursor += 1;
      tokens.push({ start, value: source.slice(start, cursor) });
      continue;
    }
    if (source.startsWith("::", cursor)) {
      push("::");
      cursor += 2;
      continue;
    }
    push(source[cursor]);
    cursor += 1;
  }
  return tokens;
}

function matchingRustToken(tokens, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    if (tokens[index].value === close) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function rustFunctionSource(source, functionName) {
  const tokens = rustArchitectureTokens(source);
  const matches = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (
      tokens[index].value !== "fn"
      || tokens[index + 1].value !== functionName
    ) {
      continue;
    }
    const openIndex = tokens.findIndex(
      (token, tokenIndex) => tokenIndex > index + 1 && token.value === "{",
    );
    if (openIndex < 0) continue;
    const closeIndex = matchingRustToken(tokens, openIndex, "{", "}");
    if (closeIndex >= 0) {
      matches.push(source.slice(tokens[index].start, tokens[closeIndex].start + 1));
    }
  }
  return matches.length === 1 ? matches[0] : "";
}

function knowledgeStoreMethods(source) {
  const tokens = rustArchitectureTokens(source);
  const methods = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "impl") continue;
    const openIndex = tokens.findIndex(
      (token, tokenIndex) => tokenIndex > index && token.value === "{",
    );
    if (openIndex < 0) break;
    const header = tokens.slice(index + 1, openIndex)
      .map((token) => token.value)
      .join("");
    const closeIndex = matchingRustToken(tokens, openIndex, "{", "}");
    if (closeIndex < 0) break;
    if (/^(?:crate::store::)?Store(?:where.*)?$/.test(header)) {
      let braceDepth = 0;
      for (let cursor = openIndex + 1; cursor < closeIndex; cursor += 1) {
        if (tokens[cursor].value === "{") {
          braceDepth += 1;
          continue;
        }
        if (tokens[cursor].value === "}") {
          braceDepth -= 1;
          continue;
        }
        if (braceDepth !== 0 || tokens[cursor].value !== "pub") continue;
        let qualifier = "public";
        let declaration = cursor + 1;
        if (tokens[declaration]?.value === "(") {
          const qualifierClose = matchingRustToken(tokens, declaration, "(", ")");
          if (qualifierClose < 0) continue;
          qualifier = tokens.slice(declaration + 1, qualifierClose)
            .map((token) => token.value)
            .join("");
          declaration = qualifierClose + 1;
        }
        while ([
          "default", "const", "async", "safe", "unsafe", "extern",
        ].includes(tokens[declaration]?.value)) {
          declaration += 1;
        }
        if (
          tokens[declaration]?.value === "fn"
          && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[declaration + 1]?.value ?? "")
        ) {
          methods.push({ name: tokens[declaration + 1].value, qualifier });
        }
      }
    }
    index = closeIndex;
  }
  return methods;
}

const knowledgeStoreVisibilityProbe = knowledgeStoreMethods(`
impl Store {
  pub(crate) fn leaked_sync() {}
  pub(in crate::features::knowledge) async fn leaked_scoped() {}
  pub async fn leaked_public() {}
  pub(crate) unsafe fn leaked_unsafe() {}
  pub(in crate::features::knowledge) const fn leaked_const() {}
  pub async unsafe fn leaked_async_unsafe() {}
  pub(crate) extern "C" fn leaked_extern() {}
  pub(crate) const unsafe extern "C-unwind" fn leaked_all_modifiers() {}
  pub(crate) safe extern "C" fn leaked_safe_extern() {}
  pub(crate) default fn leaked_default() {}
  pub(super) async unsafe fn adapter_owned_async() {}
  pub(super) const unsafe extern "C" fn adapter_owned_const() {}
  fn private_helper() {}
  const TEXT: &str = "pub(crate) unsafe fn string_decoy() {}";
  /* pub(crate) const fn comment_decoy() {} */
}
impl Repository for Store {
  pub(crate) fn trait_impl_decoy() {}
}
`);
if (
  knowledgeStoreVisibilityProbe
    .map(({ name, qualifier }) => `${qualifier}:${name}`)
    .join(",")
    !== "crate:leaked_sync,incrate::features::knowledge:leaked_scoped,public:leaked_public,crate:leaked_unsafe,incrate::features::knowledge:leaked_const,public:leaked_async_unsafe,crate:leaked_extern,crate:leaked_all_modifiers,crate:leaked_safe_extern,crate:leaked_default,super:adapter_owned_async,super:adapter_owned_const"
) {
  failures.push("Knowledge SQLite Store visibility guard self-test failed");
}
const knowledgeSqliteStoreSources = walk(knowledgeAdapterDirectory)
  .map(relative)
  .filter((filePath) => (
    filePath.endsWith(".rs")
    && filePath.startsWith(`${knowledgeAdapterDirectory}/sqlite`)
  ))
  .map((filePath) => [filePath, knowledgeStoreMethods(read(filePath))])
  .filter(([, methods]) => methods.length > 0);
if (knowledgeSqliteStoreSources.length === 0) {
  failures.push("Knowledge SQLite adapter must retain an inherent Store implementation");
}
for (const [filePath, methods] of knowledgeSqliteStoreSources) {
  const nestedStoreModule = filePath.startsWith(
    `${knowledgeAdapterDirectory}/sqlite_store/`,
  );
  for (const { name, qualifier } of methods) {
    const adapterOwned = qualifier === "super" || (
      nestedStoreModule
      && qualifier === "incrate::features::knowledge::adapters"
    );
    if (!adapterOwned) {
      failures.push(
        `${filePath}: Knowledge Store method must remain visible only inside its adapter (${name})`,
      );
    }
  }
}
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
    && !filePath.startsWith("src-tauri/src/features/knowledge/adapters/sqlite")
    && filePath !== knowledgeCompositionPath
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
    [/\bcrate::store\b/, "Knowledge facade must use kernel access contracts rather than Store-owned types"],
  ]],
  ["src-tauri/src/features/knowledge/transport.rs", [
    [/(?:super|crate::features::knowledge)::adapters|\breqwest\b|\bhosted_control_plane\b/, "Knowledge transport must consume the facade rather than concrete adapters"],
  ]],
  ["src-tauri/src/features/knowledge/ports.rs", [
    [/\breqwest\b|\bhosted_control_plane\b|\bSqliteKnowledgeRepository\b|\bHostedKnowledgeAuthority\b/, "Knowledge ports must remain adapter-neutral"],
    [/\bcrate::store\b/, "Knowledge ports must use kernel access contracts rather than persistence-owned types"],
    [/\bfeatures::agents\b/, "Knowledge ports must own their read models rather than import Agent projections"],
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
if (exists("src-tauri/src/store/repositories/knowledge.rs")) {
  failures.push("Knowledge SQLite statements must remain owned by the feature adapter, not Store repositories");
}
if (/features::knowledge::transport/.test(read("src-tauri/src/features/agents/transport.rs"))) {
  failures.push("Agent transport must call the Knowledge application facade, not Knowledge transport helpers");
}
const knowledgeTransport = read("src-tauri/src/features/knowledge/transport.rs");
const projectListQuery = rustFunctionSource(
  knowledgeTransport,
  "list_knowledge_projects_command",
);
const fetchActiveProjectInventory = rustFunctionSource(
  knowledgeTransport,
  "fetch_active_project_inventory",
);
const persistTeamProjectInventory = rustFunctionSource(
  knowledgeTransport,
  "persist_team_project_inventory",
);
const activeProjectInventory = rustFunctionSource(
  knowledgeTransport,
  "active_project_inventory",
);
if ([
  projectListQuery,
  fetchActiveProjectInventory,
  persistTeamProjectInventory,
  activeProjectInventory,
].some((source) => !source)) {
  failures.push("Knowledge Project inventory query/cache helpers must remain inspectable");
}
const compactProjectListQuery = projectListQuery.replace(/\s+/g, "");
if (
  !compactProjectListQuery.includes(
    "letprojects=fetch_active_project_inventory(&state,&scope).await?;",
  )
  || !compactProjectListQuery.includes(
    "ifletErr(error)=persist_team_project_inventory(&state,&scope,&projects).await{",
  )
  || !compactProjectListQuery.includes("tracing::warn!(")
  || !compactProjectListQuery.includes("Ok(projects)")
) {
  failures.push(
    "Knowledge Project listing must return fetched inventory while isolating cache-write failures",
  );
}
const compactStrictProjectInventory = activeProjectInventory.replace(/\s+/g, "");
if (
  !compactStrictProjectInventory.includes(
    "letprojects=fetch_active_project_inventory(state,scope).await?;",
  )
  || !compactStrictProjectInventory.includes(
    "persist_team_project_inventory(state,scope,&projects).await?;",
  )
  || !compactStrictProjectInventory.includes("Ok(projects)")
) {
  failures.push(
    "Knowledge mutation/source workflows must strictly persist fetched Project inventory",
  );
}
for (const functionName of [
  "active_remote_scope",
  "create_knowledge_environment_command",
  "connect_knowledge_local_folder",
]) {
  const caller = rustFunctionSource(knowledgeTransport, functionName);
  if (!caller || !/active_project_inventory\s*\(/.test(caller)) {
    failures.push(
      `${functionName} must use the strict Knowledge Project inventory path`,
    );
  }
}
// A Team Project list may refresh its bounded local remote-inventory cache, and
// cache failure must not hide a successful fetch. Neither phase may reconcile
// access authority or mutate grants/Environment bindings; those workflows stay
// explicit commands. Mutation/source callers use the strict wrapper instead.
if (
  /reconcile_current_access|bind_environment_connection|revoke_environment_connection/.test(
    [
      projectListQuery,
      fetchActiveProjectInventory,
      persistTeamProjectInventory,
      activeProjectInventory,
    ].join("\n"),
  )
) {
  failures.push(
    "Knowledge Project listing may cache remote inventory but must not reconcile access or bind/revoke Environment connections",
  );
}
const environmentConnectionQuery = knowledgeTransport.match(
  /pub\(crate\) async fn list_knowledge_environment_connections[\s\S]*?\n}\n\n#\[tauri::command]/,
)?.[0] ?? "";
if (/bind_environment_connection/.test(environmentConnectionQuery)) {
  failures.push("Knowledge Environment connection listing must remain a side-effect-free query");
}
if (/pub\(crate\) struct (?:AccountScope|ActiveResourceScope|PinnedConnection|CatalogCachePolicy)/.test(read("src-tauri/src/store/mod.rs"))) {
  failures.push("exact access authority must remain owned by kernel/access.rs, not Store");
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
const applicationServicesSource = read("src-tauri/src/services/mod.rs");
if (
  !applicationServicesSource.includes("let knowledge = knowledge::compose(store.clone());")
  || /knowledge::(?:adapters|ports|runtime_adapter)/.test(applicationServicesSource)
) {
  failures.push(
    "ApplicationServices must construct Knowledge only through knowledge::compose(store)",
  );
}

// Background runtimes receive their dependencies at composition time. Tauri is
// only an event/notification adapter and must never become a global AppState
// service locator or a path back into a feature transport helper.
for (const [filePath, rules] of [
  ["src-tauri/src/features/knowledge/runtime.rs", [
    [/\bAppState\b|\.state\s*::\s*</, "Knowledge watcher runtime must use injected dependencies rather than AppHandle state lookup"],
    [/\btauri(?:::|\b)/, "Knowledge watcher runtime must emit through its desktop event port"],
    [/\b(?:super::transport|crate::features::[A-Za-z0-9_]+::transport)\b/, "Knowledge watcher runtime must not call a feature transport helper"],
  ]],
  ["src-tauri/src/features/knowledge/source_sync.rs", [
    [/\bAppState\b|\.state\s*::\s*</, "Knowledge source synchronization must use its injected feature facade"],
    [/\b(?:super::transport|crate::features::[A-Za-z0-9_]+::transport)\b/, "Knowledge source synchronization must not depend on a feature transport"],
  ]],
  ["src-tauri/src/features/analysis_articles/runtime.rs", [
    [/\bAppState\b|\.state\s*::\s*</, "Analysis scheduler must use injected dependencies rather than AppHandle state lookup"],
    [/\btauri(?:::|\b)/, "Analysis scheduler must emit through its desktop runtime port"],
    [/\b(?:super::transport|crate::features::[A-Za-z0-9_]+::transport)\b/, "Analysis scheduler must not call a feature transport helper"],
  ]],
  ["src-tauri/src/features/analysis_articles/signals.rs", [
    [/\bAppState\b|\.state\s*::\s*</, "Analysis signals must use the injected Analysis facade"],
    [/\btauri(?:::|\b)/, "Analysis signals must notify through the desktop runtime port"],
    [/\b(?:super::transport|crate::features::[A-Za-z0-9_]+::transport)\b/, "Analysis signals must not call a feature transport helper"],
  ]],
]) {
  const source = read(filePath);
  for (const [pattern, reason] of rules) {
    if (pattern.test(source)) failures.push(`${filePath}: ${reason}`);
  }
}

// The ACP session actor remains singular, while platform responsibilities live
// behind small sibling ports. Keep Tauri and process/persistence details from
// accreting back into the actor module.
const acpActorPath = "src-tauri/src/features/agents/acp.rs";
const acpActor = read(acpActorPath);
if (lineCount(acpActor) > 1_850) {
  failures.push(`${acpActorPath}: ACP session actor has ${lineCount(acpActor)} lines; keep boundary work in acp/* ports`);
}
if (/\btauri(?:::|\b)/.test(acpActor)) {
  failures.push(`${acpActorPath}: ACP session actor must emit and launch through owned ports`);
}
for (const [filePath, contract] of [
  ["src-tauri/src/features/agents/acp/persistence.rs", "trait AcpSessionPersistencePort"],
  ["src-tauri/src/features/agents/acp/process.rs", "trait AcpProcessLaunchPort"],
  ["src-tauri/src/features/agents/acp/event_sink.rs", "trait AcpSessionEventSink"],
  ["src-tauri/src/features/agents/acp/knowledge_scope.rs", "trait AcpKnowledgeScopePort"],
]) {
  if (!exists(filePath) || !read(filePath).includes(contract)) {
    failures.push(`${filePath}: ACP boundary must retain ${contract}`);
  }
}

// Analysis Articles owns explicit local-repository, exact-read-execution, and
// hosted-authority ports. The generic facade and business runner must remain
// independent of SQLite, connection pools, HTTP, Tauri, and global AppState.
const analysisRoot = "src-tauri/src/features/analysis_articles";
const analysisAdapters = `${analysisRoot}/adapters`;
const knowledgeTableReferencePattern =
  /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s+["`\[]?(knowledge_[a-z0-9_]+)/i;
const knowledgeAdapterReferencePattern =
  /\bfeatures(?:::|\/)knowledge(?:::|\/)adapters\b/;
if (
  !knowledgeTableReferencePattern.test("SELECT * FROM knowledge_mapping_proposals")
  || !knowledgeAdapterReferencePattern.test("crate::features::knowledge::adapters")
  || knowledgeAdapterReferencePattern.test("crate::features::knowledge::KnowledgeFeature")
) {
  failures.push("Analysis-to-Knowledge boundary guard self-test failed");
}
for (const filePath of walk(analysisRoot).map(relative).filter((candidate) => candidate.endsWith(".rs"))) {
  const source = read(filePath);
  const adapter = filePath.startsWith(`${analysisAdapters}/`);
  const knowledgeTable = source.match(knowledgeTableReferencePattern)?.[1];
  if (knowledgeTable) {
    failures.push(
      `${filePath}: Analysis must read Knowledge data through KnowledgeFeature (${knowledgeTable})`,
    );
  }
  if (knowledgeAdapterReferencePattern.test(source)) {
    failures.push(
      `${filePath}: Analysis must depend on the Knowledge facade, not Knowledge adapters`,
    );
  }
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

// Shared protocol validation protects only the reviewed cross-runtime safety
// and authority invariants. Workspace Cloud remains authoritative for full
// Analysis schedule/config policy, so Rust must not grow a second cron/IANA
// parser or acquire transport/storage dependencies.
const analysisValidationPath =
  "dopedb-protocol/src/analysis_article_validation.rs";
const analysisSqlValidationPath =
  "dopedb-protocol/src/analysis_article_sql.rs";
const controlPlaneProtocolPath = "dopedb-protocol/src/control_plane.rs";
for (const [filePath, limit] of [
  [analysisValidationPath, 550],
  [analysisSqlValidationPath, 150],
]) {
  const lines = lineCount(read(filePath));
  if (lines > limit) {
    failures.push(
      `${filePath}: shared protocol validator has ${lines} lines; keep it below ${limit}`,
    );
  }
}
const analysisValidation = read(analysisValidationPath);
if (
  !analysisValidation.includes(
    "Workspace Cloud remains the authoritative parser",
  )
  || !analysisValidation.includes(
    "duplicate those feature-owned parsers",
  )
) {
  failures.push(
    `${analysisValidationPath}: validator must retain the Cloud-authoritative policy boundary`,
  );
}
if (
  /\bchrono_tz\b|\bcron(?:_parser)?::|\bCronExpressionParser\b|\bcron-parser\b/.test(
    analysisValidation,
  )
) {
  failures.push(
    `${analysisValidationPath}: Rust must not duplicate Cloud cron or IANA timezone policy`,
  );
}
for (const filePath of [
  analysisValidationPath,
  analysisSqlValidationPath,
  controlPlaneProtocolPath,
]) {
  if (/\b(?:reqwest|sqlx|tauri)(?:::|\b)/.test(read(filePath))) {
    failures.push(
      `${filePath}: shared protocol validation must remain transport and storage neutral`,
    );
  }
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
