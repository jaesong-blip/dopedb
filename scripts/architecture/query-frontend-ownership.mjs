import path from "node:path";
import { parse } from "@babel/parser";

const queryAdapterOwner = "src/features/queries/tauriAdapter.ts";
const queryDomainOwner = "src/features/queries/domain.ts";
const queryCommands = ["classify_sql", "preview_sql", "propose_sql", "run_sql"];
const queryCommandFunctions = [
  "classifySql",
  "previewSql",
  "proposeSql",
  "runSql",
  "runSqlRead",
];
const queryContractTypes = [
  "RiskLevel",
  "Classification",
  "PreviewMode",
  "PreviewReport",
  "SqlOperationProposal",
];

function walkAst(node, visit, parent = null) {
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit, parent);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "loc" && key !== "start" && key !== "end") {
      walkAst(child, visit, node);
    }
  }
}

function frontendModuleTarget(filePath, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  return path.posix
    .normalize(path.posix.join(path.posix.dirname(filePath), specifier))
    .replace(/\.(?:ts|tsx)$/, "");
}

function isFeatureModule(filePath, specifier, owner) {
  return frontendModuleTarget(filePath, specifier) === owner.replace(/\.(?:ts|tsx)$/, "");
}

function exportedDeclarationNames(declaration) {
  if (!declaration) return [];
  if (declaration.id?.name) return [declaration.id.name];
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations
      .map((item) => (item.id.type === "Identifier" ? item.id.name : null))
      .filter(Boolean);
  }
  return [];
}

export function inspectFrontendQueryOwnership(filePath, source) {
  let program;
  try {
    program = parse(source, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    }).program;
  } catch (error) {
    return {
      commands: [],
      contractDeclarations: [],
      functionDeclarations: [],
      issues: [`${filePath}: could not parse frontend ownership: ${error.message}`],
    };
  }

  const issues = [];
  const isTestFile = /\.(?:test|spec)\.[^.]+$/.test(filePath);
  const commands = [];
  const contractDeclarations = [];
  const functionDeclarations = [];
  const invokeBindings = new Set();
  const invokeNamespaces = new Set();
  const queryFeatureBindings = new Set();
  const queryFeatureNamespaces = new Set();
  const variableDeclarations = [];
  const exportDeclarations = [];

  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const module = statement.source.value;
    const isTauriCore = module === "@tauri-apps/api/core";
    const isQueryAdapter = isFeatureModule(filePath, module, queryAdapterOwner);
    const isQueryDomain = isFeatureModule(filePath, module, queryDomainOwner);
    for (const specifier of statement.specifiers) {
      if (
        isTauriCore &&
        specifier.type === "ImportSpecifier" &&
        (specifier.imported.name ?? specifier.imported.value) === "invoke"
      ) {
        invokeBindings.add(specifier.local.name);
      }
      if (isTauriCore && specifier.type === "ImportNamespaceSpecifier") {
        invokeNamespaces.add(specifier.local.name);
        if (!isTestFile) {
          issues.push(`${filePath}: Tauri invoke must be imported directly, not as a namespace`);
        }
      }
      if (isQueryAdapter || isQueryDomain) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          queryFeatureNamespaces.add(specifier.local.name);
        } else {
          queryFeatureBindings.add(specifier.local.name);
        }
      }
    }
  }

  function isInvokeReference(node) {
    if (node?.type === "Identifier") return invokeBindings.has(node.name);
    if (node?.type !== "MemberExpression") return false;
    if (node.object.type !== "Identifier" || !invokeNamespaces.has(node.object.name)) {
      return false;
    }
    return (
      (!node.computed && node.property.type === "Identifier" && node.property.name === "invoke") ||
      (node.computed && node.property.type === "StringLiteral" && node.property.value === "invoke")
    );
  }

  function isNamespaceReference(node, namespaces) {
    return node?.type === "Identifier" && namespaces.has(node.name);
  }

  function isQueryReference(node) {
    if (node?.type === "Identifier") return queryFeatureBindings.has(node.name);
    return (
      node?.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      queryFeatureNamespaces.has(node.object.name)
    );
  }

  function containsQueryReference(node) {
    let found = false;
    walkAst(node, (candidate) => {
      if (isQueryReference(candidate)) found = true;
    });
    return found;
  }

  function exportedDeclarationReexportsQuery(declaration) {
    if (!declaration) return false;
    if (declaration.type === "VariableDeclaration") {
      return declaration.declarations.some((item) => isQueryReference(item.init));
    }
    if (declaration.type === "TSTypeAliasDeclaration") {
      return containsQueryReference(declaration.typeAnnotation);
    }
    return isQueryReference(declaration);
  }

  walkAst(program, (node) => {
    if (node.type === "VariableDeclarator") variableDeclarations.push(node);
    if (
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportDefaultDeclaration"
    ) {
      exportDeclarations.push(node);
    }
    if (!isTestFile && node.type === "ImportExpression") {
      if (node.source?.type !== "StringLiteral") {
        issues.push(`${filePath}: dynamic module identifiers bypass static command ownership`);
        return;
      }
      const module = node.source.value;
      if (module === "@tauri-apps/api/core") {
        issues.push(`${filePath}: dynamic Tauri core imports bypass static command ownership`);
      }
      if (
        isFeatureModule(filePath, module, queryAdapterOwner) ||
        isFeatureModule(filePath, module, queryDomainOwner)
      ) {
        issues.push(`${filePath}: dynamic Query feature imports bypass static command ownership`);
      }
    }
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of variableDeclarations) {
      const fromInvoke =
        isInvokeReference(declaration.init) ||
        isNamespaceReference(declaration.init, invokeNamespaces);
      const fromQuery =
        isQueryReference(declaration.init) ||
        isNamespaceReference(declaration.init, queryFeatureNamespaces);
      const destructuresInvoke =
        declaration.id.type === "ObjectPattern" &&
        isNamespaceReference(declaration.init, invokeNamespaces);
      const destructuresQuery =
        declaration.id.type === "ObjectPattern" &&
        isNamespaceReference(declaration.init, queryFeatureNamespaces);
      if (!isTestFile && (fromInvoke || destructuresInvoke)) {
        issues.push(`${filePath}: Tauri invoke must not be rebound through a variable alias`);
      }
      if (fromQuery || destructuresQuery) {
        issues.push(`${filePath}: Query feature imports must not be rebound through variable aliases`);
      }
      if (declaration.id.type !== "Identifier") continue;
      if (fromInvoke && !invokeBindings.has(declaration.id.name)) {
        invokeBindings.add(declaration.id.name);
        changed = true;
      }
      if (
        isNamespaceReference(declaration.init, invokeNamespaces) &&
        !invokeNamespaces.has(declaration.id.name)
      ) {
        invokeNamespaces.add(declaration.id.name);
        changed = true;
      }
      if (fromQuery && !queryFeatureBindings.has(declaration.id.name)) {
        queryFeatureBindings.add(declaration.id.name);
        changed = true;
      }
      if (
        isNamespaceReference(declaration.init, queryFeatureNamespaces) &&
        !queryFeatureNamespaces.has(declaration.id.name)
      ) {
        queryFeatureNamespaces.add(declaration.id.name);
        changed = true;
      }
    }
  }

  for (const declaration of exportDeclarations) {
    const sourceModule = declaration.source?.value;
    if (!isTestFile && sourceModule === "@tauri-apps/api/core") {
      issues.push(`${filePath}: Tauri invoke must not be re-exported`);
    }
    if (
      sourceModule &&
      (isFeatureModule(filePath, sourceModule, queryAdapterOwner) ||
        isFeatureModule(filePath, sourceModule, queryDomainOwner))
    ) {
      issues.push(`${filePath}: Query feature modules must not be re-exported`);
    }
    if (exportedDeclarationReexportsQuery(declaration.declaration)) {
      issues.push(`${filePath}: Query feature imports must not be exported through declarations`);
    }
    for (const specifier of declaration.specifiers ?? []) {
      if (
        queryFeatureBindings.has(specifier.local?.name) ||
        queryFeatureNamespaces.has(specifier.local?.name)
      ) {
        issues.push(`${filePath}: Query feature imports must not be re-exported through aliases`);
      }
      const exported = specifier.exported?.name ?? specifier.exported?.value;
      if (queryCommandFunctions.includes(exported)) functionDeclarations.push(exported);
      if (queryContractTypes.includes(exported)) contractDeclarations.push(exported);
    }
    for (const name of exportedDeclarationNames(declaration.declaration)) {
      if (queryCommandFunctions.includes(name)) functionDeclarations.push(name);
      if (queryContractTypes.includes(name)) contractDeclarations.push(name);
    }
  }

  walkAst(program, (node) => {
    if (node.type !== "CallExpression" || !isInvokeReference(node.callee)) return;
    const command = node.arguments[0];
    if (!isTestFile && command?.type !== "StringLiteral") {
      issues.push(`${filePath}: Tauri invoke command names must be static quoted literals`);
      return;
    }
    if (queryCommands.includes(command.value)) commands.push(command.value);
  });

  walkAst(program, (node, parent) => {
    if (!isTestFile && node.type === "MemberExpression" && isInvokeReference(node.object)) {
      issues.push(`${filePath}: Tauri invoke must not be wrapped through a member alias`);
    }
    if (!isTestFile && node.type === "Identifier" && invokeBindings.has(node.name)) {
      const isImportLocal =
        parent?.type === "ImportSpecifier" &&
        (parent.local === node || parent.imported === node);
      const isDirectInvoke = parent?.type === "CallExpression" && parent.callee === node;
      const isAliasDeclaration = parent?.type === "VariableDeclarator" && parent.init === node;
      const isAliasBinding = parent?.type === "VariableDeclarator" && parent.id === node;
      if (!isImportLocal && !isDirectInvoke && !isAliasDeclaration && !isAliasBinding) {
        issues.push(`${filePath}: Tauri invoke must not be passed through an indirect alias`);
      }
    }
  });

  return { commands, contractDeclarations, functionDeclarations, issues };
}

export function collectQueryFrontendOwnershipDiagnostics({
  frontendSource,
  frontendProductionSource,
}) {
  const diagnostics = [];
  const ownership = new Map();
  for (const [filePath, source] of frontendSource) {
    const inspection = inspectFrontendQueryOwnership(filePath, source);
    ownership.set(filePath, inspection);
    diagnostics.push(...inspection.issues);
  }

  for (const command of queryCommands) {
    const owners = frontendProductionSource
      .filter(([filePath]) => ownership.get(filePath).commands.includes(command))
      .map(([filePath]) => filePath);
    if (owners.length !== 1 || owners[0] !== queryAdapterOwner) {
      diagnostics.push(
        `${command}: expected only ${queryAdapterOwner}, found ${owners.join(", ") || "none"}`,
      );
    }
  }
  for (const functionName of queryCommandFunctions) {
    const owners = frontendProductionSource
      .filter(([filePath]) => ownership.get(filePath).functionDeclarations.includes(functionName))
      .map(([filePath]) => filePath);
    if (owners.length !== 1 || owners[0] !== queryAdapterOwner) {
      diagnostics.push(
        `${functionName}: expected only ${queryAdapterOwner}, found ${owners.join(", ") || "none"}`,
      );
    }
  }
  for (const typeName of queryContractTypes) {
    const owners = frontendSource
      .filter(([filePath]) => ownership.get(filePath).contractDeclarations.includes(typeName))
      .map(([filePath]) => filePath);
    if (owners.length !== 1 || owners[0] !== queryDomainOwner) {
      diagnostics.push(
        `${typeName}: expected only ${queryDomainOwner}, found ${owners.join(", ") || "none"}`,
      );
    }
  }

  for (const [name, source, expectedIssue] of [
    [
      "Tauri namespace and destructured invoke alias",
      'import * as core from "@tauri-apps/api/core"; const api = core; const { invoke: call } = api; const dynamic = ["run", "sql"].join("_"); call(dynamic);',
      "must be imported directly",
    ],
    [
      "Query namespace destructuring re-export",
      'import * as queries from "./tauriAdapter"; const { runSql: executeSql } = queries; export { executeSql };',
      "must not be rebound through variable aliases",
    ],
    [
      "Query value re-export",
      'import { runSql } from "./tauriAdapter"; export const executeSql = runSql;',
      "must not be rebound through variable aliases",
    ],
    [
      "direct invoke alias",
      'import { invoke } from "@tauri-apps/api/core"; const call = invoke; call("run_sql");',
      "must not be rebound through a variable alias",
    ],
    [
      "dynamic Tauri module identifier",
      'const coreName = "@tauri-apps/api/core"; import(coreName);',
      "dynamic module identifiers bypass static command ownership",
    ],
    [
      "dynamic Tauri core literal",
      'import("@tauri-apps/api/core");',
      "dynamic Tauri core imports bypass static command ownership",
    ],
    [
      "dynamic Query adapter literal",
      'import("./tauriAdapter");',
      "dynamic Query feature imports bypass static command ownership",
    ],
    [
      "dynamic Query domain literal",
      'import("./domain");',
      "dynamic Query feature imports bypass static command ownership",
    ],
  ]) {
    const issues = inspectFrontendQueryOwnership(
      "src/features/queries/guardFixture.ts",
      source,
    ).issues;
    if (!issues.some((issue) => issue.includes(expectedIssue))) {
      diagnostics.push(`Query ownership guard self-test failed for ${name}`);
    }
  }
  return diagnostics;
}

export function collectQueryCentralIpcDiagnostics(frontendSource) {
  const diagnostics = [];
  for (const [filePath, source] of frontendSource) {
    if (
      /import\s+(?:type\s+)?\{[^}]*\b(?:RiskLevel|Classification|PreviewMode|PreviewReport|SqlOperationProposal)\b[^}]*\}\s*from\s*["'][^"']*ipc\/types["']/.test(
        source,
      )
    ) {
      diagnostics.push(`${filePath}: imports a SQL Query contract from the removed central owner`);
    }
    if (
      /import\s*\{[^}]*\b(?:classifySql|previewSql|proposeSql|runSql|runSqlRead)\b[^}]*\}\s*from\s*["'][^"']*ipc\/commands["']/.test(
        source,
      )
    ) {
      diagnostics.push(`${filePath}: imports a SQL Query command from the removed central owner`);
    }
  }
  return diagnostics;
}
