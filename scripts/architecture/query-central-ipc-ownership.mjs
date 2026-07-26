import { parse } from "@babel/parser";

const queryContractTypes = [
  "RiskLevel",
  "Classification",
  "PreviewMode",
  "PreviewReport",
  "SqlInspection",
  "SqlOperationProposal",
];
const queryFeatureOwnedTypes = ["SqlInspection", "SqlOperationProposal"];

function walkAst(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "loc" && key !== "start" && key !== "end") {
      walkAst(child, visit);
    }
  }
}

function bindingNames(pattern) {
  if (pattern?.type === "Identifier") return [pattern.name];
  if (pattern?.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern?.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) =>
      bindingNames(
        property.type === "ObjectProperty" ? property.value : property.argument,
      ),
    );
  }
  if (pattern?.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames);
  return [];
}

function isQueryContractSource(value) {
  return /(?:^|\/)features\/queries\/(?:domain|generated\/contracts)$/.test(
    value.replace(/\.(?:ts|tsx)$/, ""),
  );
}

function inspectCentralQueryContractOwnership(filePath, source) {
  if (!/^src\/ipc\/(?:types\.ts|generated\/.*\.ts)$/.test(filePath)) return [];

  let program;
  try {
    program = parse(source, {
      sourceType: "module",
      plugins: ["typescript"],
    }).program;
  } catch (error) {
    return [`${filePath}: could not parse central IPC ownership: ${error.message}`];
  }

  const issues = [];
  const bindings = new Set();
  const namespaces = new Set();
  const aliases = new Set();

  for (const statement of program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      !isQueryContractSource(statement.source.value)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const destination =
        specifier.type === "ImportNamespaceSpecifier" ? namespaces : bindings;
      destination.add(specifier.local.name);
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
        const memberNamespace =
          init?.type === "MemberExpression" &&
          init.object.type === "Identifier"
            ? init.object.name
            : undefined;
        const fromNamespace = Boolean(identifier && namespaces.has(identifier));
        const fromBinding = Boolean(
          identifier && (bindings.has(identifier) || aliases.has(identifier)),
        );
        const fromNamespaceMember = Boolean(
          memberNamespace && namespaces.has(memberNamespace),
        );
        if (!(fromNamespace || fromBinding || fromNamespaceMember)) continue;

        const destination =
          declaration.id.type === "Identifier" && fromNamespace
            ? namespaces
            : aliases;
        for (const name of bindingNames(declaration.id)) {
          if (!destination.has(name)) {
            destination.add(name);
            changed = true;
          }
        }
      }
    }
  }

  function containsQueryReference(node) {
    let found = false;
    walkAst(node, (candidate) => {
      if (
        candidate.type === "Identifier" &&
        (bindings.has(candidate.name) ||
          namespaces.has(candidate.name) ||
          aliases.has(candidate.name))
      ) {
        found = true;
      }
    });
    return found;
  }

  walkAst(program, (node) => {
    if (node.type === "ImportExpression") {
      if (
        node.source?.type !== "StringLiteral" ||
        isQueryContractSource(node.source.value)
      ) {
        issues.push(`${filePath}: central IPC dynamic Query import is forbidden`);
      }
      return;
    }
    if (
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportDefaultDeclaration" &&
      node.type !== "ExportAllDeclaration"
    ) {
      return;
    }
    if (isQueryContractSource(node.source?.value ?? "")) {
      issues.push(`${filePath}: central IPC must not re-export Query contracts`);
    }
    if (containsQueryReference(node.declaration)) {
      issues.push(
        `${filePath}: central IPC must not export Query contracts through declarations`,
      );
    }
    const declaredName = node.declaration?.id?.name;
    if (queryFeatureOwnedTypes.includes(declaredName)) {
      issues.push(
        `${filePath}: central IPC must not redeclare Query contract ${declaredName}`,
      );
    }
    for (const specifier of node.specifiers ?? []) {
      const local = specifier.local?.name;
      const exported = specifier.exported?.name ?? specifier.exported?.value;
      if (
        queryContractTypes.includes(exported) ||
        bindings.has(local) ||
        namespaces.has(local) ||
        aliases.has(local)
      ) {
        issues.push(`${filePath}: central IPC must not re-export Query contracts`);
      }
    }
  });
  return issues;
}

export function collectQueryCentralIpcDiagnostics(frontendSource) {
  const diagnostics = [];
  for (const [filePath, source] of frontendSource) {
    if (
      /import\s+(?:type\s+)?\{[^}]*\b(?:RiskLevel|Classification|PreviewMode|PreviewReport|SqlInspection|SqlOperationProposal)\b[^}]*\}\s*from\s*["'][^"']*ipc\/types["']/.test(
        source,
      )
    ) {
      diagnostics.push(
        `${filePath}: imports a SQL Query contract from the removed central owner`,
      );
    }
    if (
      /import\s*\{[^}]*\b(?:classifySql|previewSql|inspectSql|proposeSql|runSql|runSqlRead)\b[^}]*\}\s*from\s*["'][^"']*ipc\/commands["']/.test(
        source,
      )
    ) {
      diagnostics.push(
        `${filePath}: imports a SQL Query command from the removed central owner`,
      );
    }
    diagnostics.push(...inspectCentralQueryContractOwnership(filePath, source));
  }

  for (const [name, source] of [
    ["named", 'export type { RiskLevel } from "../features/queries/domain";'],
    ["namespace", 'import * as query from "../features/queries/domain"; export { query };'],
    [
      "alias",
      'import { PreviewReport as report } from "../features/queries/domain"; const copy = report; export { copy };',
    ],
    ["dynamic", 'import("../features/queries/domain").then((query) => query.RiskLevel);'],
    ["template", 'import(`../features/queries/domain`);'],
    [
      "generated named",
      'export type { SqlInspection } from "../features/queries/generated/contracts";',
    ],
    ["generated star", 'export * from "../features/queries/generated/contracts";'],
    [
      "generated namespace",
      'import * as query from "../features/queries/generated/contracts"; export { query };',
    ],
    [
      "generated alias",
      'import { SqlOperationProposal as proposal } from "../features/queries/generated/contracts"; const copy = proposal; export { copy };',
    ],
    [
      "generated destructured alias",
      'import * as query from "../features/queries/generated/contracts"; const { SqlInspection: inspection } = query; export { inspection };',
    ],
    [
      "generated dynamic",
      'import("../features/queries/generated/contracts").then((query) => query.SqlInspection);',
    ],
    ["generated template", 'import(`../features/queries/generated/contracts`);'],
    [
      "generated declaration alias",
      'import type { SqlInspection } from "../features/queries/generated/contracts"; export type Inspection = SqlInspection;',
    ],
    [
      "generated default alias",
      'import * as query from "../features/queries/generated/contracts"; const copy = query; export default copy;',
    ],
    ["generated redeclaration", "export interface SqlInspection { report: unknown }"],
  ]) {
    if (
      !inspectCentralQueryContractOwnership("src/ipc/types.ts", source).length
    ) {
      diagnostics.push(`Query central IPC guard self-test failed for ${name}`);
    }
  }
  return diagnostics;
}
