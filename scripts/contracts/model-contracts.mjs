#!/usr/bin/env node
// Regenerate Rust serde bindings and verify the checked-in TypeScript facade is an
// identity-preserving view of those bindings (not a hand-maintained approximation).
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "@babel/parser";
import {
  generatedContractArtifacts,
  unverifiedCompatibilityFacadeExports,
} from "./contract-manifest.mjs";
import { validateContractSemantics } from "./semantic-contracts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const generated = generatedContractArtifacts.map(({ artifact }) => artifact);
const mode = process.argv[2];

if (mode !== "--generate" && mode !== "--check") {
  throw new Error("usage: model-contracts.mjs --generate|--check");
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}

function program(filePath) {
  const location = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  return parse(readFileSync(location, "utf8"), {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  }).program;
}

function nameOf(node) {
  return node?.type === "Identifier" ? node.name : node?.value;
}

function facadeExports() {
  const bySource = new Map();
  const direct = new Set();
  const facade = process.env.DOPEDB_CONTRACT_TYPES_PATH ?? "src/ipc/types.ts";
  for (const statement of program(facade).body) {
    if (statement.type === "ExportNamedDeclaration" && statement.source) {
      const entries = bySource.get(statement.source.value) ?? new Map();
      for (const specifier of statement.specifiers) {
        entries.set(nameOf(specifier.exported), nameOf(specifier.local));
      }
      bySource.set(statement.source.value, entries);
    }
    if (statement.type === "ExportNamedDeclaration" && statement.declaration
      && ["TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSEnumDeclaration"].includes(statement.declaration.type)) {
      direct.add(statement.declaration.id.name);
    }
  }
  return { bySource, direct, facade };
}

const generatedFacadeAliases = generatedContractArtifacts.flatMap(({ facadeAliases }) => facadeAliases);

function isQueryOwnedSource(source) {
  return /(?:^|\/)features\/queries\/(?:domain|generated\/contracts)$/.test(source);
}

function sourceValue(node) {
  return node?.source?.value;
}

function bindingNames(pattern) {
  if (pattern?.type === "Identifier") return [pattern.name];
  if (pattern?.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern?.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) => (
      property.type === "ObjectProperty" ? bindingNames(property.value) : bindingNames(property.argument)
    ));
  }
  return [];
}

function queryExportDiagnostics(filePath, source) {
  const diagnostics = [];
  const program = parse(source, { sourceType: "module", plugins: ["typescript"] }).program;
  const queryBindings = new Set();
  const queryNamespaces = new Set();
  const aliases = new Set();
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" && isQueryOwnedSource(statement.source.value)) {
      for (const specifier of statement.specifiers) {
        (specifier.type === "ImportNamespaceSpecifier" ? queryNamespaces : queryBindings).add(specifier.local.name);
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of program.body) {
      if (statement.type !== "VariableDeclaration") continue;
      for (const declaration of statement.declarations) {
        const init = declaration.init;
        const identifier = init?.type === "Identifier" ? init.name : undefined;
        const memberNamespace = init?.type === "MemberExpression" && init.object.type === "Identifier"
          ? init.object.name
          : undefined;
        const fromNamespace = Boolean(identifier && queryNamespaces.has(identifier));
        const fromQuery = Boolean(identifier && (queryBindings.has(identifier) || aliases.has(identifier)));
        const fromNamespaceMember = Boolean(memberNamespace && queryNamespaces.has(memberNamespace));
        if (!(fromNamespace || fromQuery || fromNamespaceMember)) continue;
        for (const name of bindingNames(declaration.id)) {
          const destination = declaration.id.type === "Identifier" && fromNamespace ? queryNamespaces : aliases;
          if (!destination.has(name)) {
            destination.add(name);
            changed = true;
          }
        }
      }
    }
  }
  for (const statement of program.body) {
    if (statement.type === "ExportAllDeclaration" || statement.type === "ExportNamedDeclaration") {
      if (isQueryOwnedSource(sourceValue(statement) ?? "")) diagnostics.push(`${filePath}: generated IPC must not re-export Query contracts`);
      for (const specifier of statement.specifiers ?? []) {
        const local = nameOf(specifier.local);
        const exported = nameOf(specifier.exported);
        if (queryBindings.has(local) || queryNamespaces.has(local) || aliases.has(local) || ["SqlInspection", "SqlOperationProposal"].includes(exported)) {
          diagnostics.push(`${filePath}: generated IPC must not re-export Query contracts`);
        }
      }
    }
  }
  return diagnostics;
}

function validateFacade() {
  const { bySource, direct, facade } = facadeExports();
  const aliasesBySource = new Map();
  for (const [source, exported] of generatedFacadeAliases) {
    const entries = aliasesBySource.get(source) ?? new Set();
    entries.add(exported);
    aliasesBySource.set(source, entries);
  }
  for (const [source, exported, imported] of generatedFacadeAliases) {
    if (bySource.get(source)?.get(exported) !== imported) {
      throw new Error(`contract facade ${exported} must be a direct alias of ${source}:${imported}`);
    }
  }
  // The sole derived catalog vocabulary is a projection of the generated object,
  // never a duplicate literal union. All remaining local exports have an owner.
  for (const [source, exports] of bySource) {
    if (isQueryOwnedSource(source)) {
      throw new Error(`contract facade must not re-export Query-owned contracts from ${source}: ${[...exports.keys()].join(", ")}`);
    }
    if (source.startsWith("./generated/") && !aliasesBySource.has(source)) {
      throw new Error(`contract facade has an unmanifested generated source ${source}`);
    }
    for (const exported of exports.keys()) {
      if (source.startsWith("./generated/") && !aliasesBySource.get(source)?.has(exported)) {
        throw new Error(`contract facade has an unmanifested generated export ${source}:${exported}`);
      }
    }
  }
  for (const entry of readdirSync(path.join(root, "src/ipc/generated"), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const filePath = `src/ipc/generated/${entry.name}`;
    const diagnostics = queryExportDiagnostics(filePath, readFileSync(path.join(root, filePath), "utf8"));
    if (diagnostics.length) throw new Error(diagnostics.join("\n"));
  }
  const allowedDirect = new Set([
    "PlatformFeatureFlag",
    "CatalogObjectKind",
    "AppErrorDetails",
    ...unverifiedCompatibilityFacadeExports,
  ]);
  for (const name of direct) {
    if (!allowedDirect.has(name)) throw new Error(`unlisted manual contract ${name}`);
  }
  const diagnostics = validateContractSemantics({ root, facadePath: facade });
  if (diagnostics.length) throw new Error(diagnostics.join("\n"));
}

function validateTestOnlyCodegen() {
  for (const manifestPath of ["src-tauri/Cargo.toml", "dopedb-protocol/Cargo.toml"]) {
    const cargo = readFileSync(path.join(root, manifestPath), "utf8");
    if (/^ts-rs\s*=/m.test(cargo.split("[dev-dependencies]", 1)[0])) {
      throw new Error(`${manifestPath} must keep ts-rs in dev-dependencies only`);
    }
  }
}

function validateGeneratedFormatting() {
  for (const filePath of generated) {
    const source = readFileSync(path.join(root, filePath), "utf8");
    if (/[ \t]+$/mu.test(source)) {
      throw new Error(`${filePath} contains trailing whitespace; regenerate the Rust contract`);
    }
  }
}

function runContractTests(generate) {
  const env = generate ? { ...process.env, DOPEDB_CONTRACT_GENERATE: "1" } : process.env;
  const checkRoot = generate ? null : mkdtempSync(path.join(tmpdir(), "dopedb-contracts-"));
  try {
    for (const [manifest, filter, outputVariable, artifact] of [
      [
        "src-tauri/Cargo.toml",
        "generated_model_contracts_are_current",
        "DOPEDB_CONTRACT_OUTPUT",
        "src/ipc/generated/model.ts",
      ],
      [
        "src-tauri/Cargo.toml",
        "generated_query_receipt_contracts_are_current",
        "DOPEDB_QUERY_CONTRACT_OUTPUT",
        "src/features/queries/generated/contracts.ts",
      ],
      [
        "src-tauri/Cargo.toml",
        "generated_catalog_feature_contracts_are_current",
        "DOPEDB_CATALOG_FEATURE_CONTRACT_OUTPUT",
        "src/ipc/generated/catalog-feature-contracts.ts",
      ],
      [
        "dopedb-protocol/Cargo.toml",
        "generated_protocol_contracts_are_current",
        "DOPEDB_PROTOCOL_CONTRACT_OUTPUT",
        "src/ipc/generated/protocol-contracts.ts",
      ],
    ]) {
      // Contract-only unit tests run before CI stages the platform sidecars. The
      // production Tauri config still owns those binaries; this test-only override
      // prevents tauri-build from requiring bundle resources that the contract
      // generators neither execute nor inspect.
      let contractEnv = manifest === "src-tauri/Cargo.toml"
        ? { ...env, TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [] } }) }
        : env;
      if (checkRoot) {
        // Git may materialize the checked-in TypeScript with CRLF on Windows.
        // Preserve exact contract bytes apart from that platform line-ending
        // representation before Rust performs its deterministic equality check.
        const checkPath = path.join(checkRoot, path.basename(artifact));
        const checkedIn = readFileSync(path.join(root, artifact), "utf8")
          .replace(/\r\n?/gu, "\n");
        writeFileSync(checkPath, checkedIn, "utf8");
        contractEnv = { ...contractEnv, [outputVariable]: checkPath };
      }
      run("cargo", ["test", "--manifest-path", manifest, filter, "--lib"], contractEnv);
    }
  } finally {
    if (checkRoot) rmSync(checkRoot, { recursive: true, force: true });
  }
}

if (mode === "--generate") runContractTests(true);
else {
  generated.forEach((filePath) => readFileSync(path.join(root, filePath), "utf8"));
  runContractTests(false);
}
validateGeneratedFormatting();
validateTestOnlyCodegen();
validateFacade();
