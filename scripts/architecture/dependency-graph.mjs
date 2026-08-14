import path from "node:path";

import { parse } from "@babel/parser";

function parseModule(source) {
  let parseError;
  for (const plugins of [["typescript"], ["typescript", "jsx"]]) {
    try {
      return parse(source, { plugins, sourceType: "module" }).program;
    } catch (error) {
      parseError = error;
    }
  }
  throw parseError;
}

function declarationIsTypeOnly(declaration) {
  if (
    declaration.importKind === "type"
    || declaration.importKind === "typeof"
    || declaration.exportKind === "type"
  ) {
    return true;
  }
  if (!declaration.specifiers?.length) return false;
  return declaration.specifiers.every((specifier) => (
    specifier.importKind === "type"
    || specifier.importKind === "typeof"
    || specifier.exportKind === "type"
  ));
}

function collectModuleSpecifiers(
  source,
  { includeDynamic = false, includeTypeOnly = false } = {},
) {
  const program = parseModule(source);
  const specifiers = [];
  for (const declaration of program.body) {
    if (
      declaration.type !== "ImportDeclaration"
      && declaration.type !== "ExportNamedDeclaration"
      && declaration.type !== "ExportAllDeclaration"
    ) {
      continue;
    }
    if (!declaration.source || (!includeTypeOnly && declarationIsTypeOnly(declaration))) {
      continue;
    }
    specifiers.push(declaration.source.value);
  }
  if (includeDynamic) {
    const dynamicSpecifiers = [];
    const pending = [...program.body];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node || typeof node !== "object") continue;
      if (
        node.type === "ImportExpression"
        && node.source?.type === "StringLiteral"
      ) {
        dynamicSpecifiers.push([node.start ?? Number.MAX_SAFE_INTEGER, node.source.value]);
        continue;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          pending.push(...value);
        } else if (value && typeof value === "object") {
          pending.push(value);
        }
      }
    }
    specifiers.push(...dynamicSpecifiers
      .sort(([left], [right]) => left - right)
      .map(([, specifier]) => specifier));
  }
  return specifiers;
}

export function staticRuntimeModuleSpecifiers(
  source,
  { includeDynamic = false } = {},
) {
  return collectModuleSpecifiers(source, { includeDynamic });
}

export function allModuleSpecifiers(
  source,
  { includeDynamic = false } = {},
) {
  return collectModuleSpecifiers(source, { includeDynamic, includeTypeOnly: true });
}

export function resolveLocalModuleSpecifier(
  fromFile,
  specifier,
  sourceFiles,
) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  );
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.tsx"),
  ]) {
    if (sourceFiles.has(candidate)) return candidate;
  }
  return null;
}

export function buildRuntimeDependencyGraph(
  sourceEntries,
  { includeDynamic = false } = {},
) {
  const sources = new Map(sourceEntries);
  const sourceFiles = new Set(sources.keys());
  const graph = new Map();
  const specifiers = new Map();
  for (const filePath of [...sourceFiles].sort()) {
    const runtimeSpecifiers = staticRuntimeModuleSpecifiers(
      sources.get(filePath),
      { includeDynamic },
    );
    specifiers.set(filePath, runtimeSpecifiers);
    graph.set(
      filePath,
      runtimeSpecifiers
        .map((specifier) =>
          resolveLocalModuleSpecifier(filePath, specifier, sourceFiles)
        )
        .filter(Boolean),
    );
  }
  return { graph, specifiers };
}

export function findDependencyPath(graph, start, matches) {
  if (!graph.has(start)) return null;
  const pending = [[start]];
  const visited = new Set([start]);
  while (pending.length > 0) {
    const currentPath = pending.shift();
    const current = currentPath[currentPath.length - 1];
    if (matches(current)) return currentPath;
    for (const dependency of graph.get(current) ?? []) {
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      pending.push([...currentPath, dependency]);
    }
  }
  return null;
}

export function collectDependencyParserSelfDiagnostics() {
  const fixture = `
import defaultValue from "./static-default"
import {
  type TypeOnlyMember,
  runtimeMember,
} from "./static-named"
export {
  runtimeMember as reexported,
} from "./static-export"
export * from "./static-all"
import "./side-effect"
import type { TypeOnlyImport } from "./type-only-import"
export type { TypeOnlyExport } from "./type-only-export"
const stringOnly = 'import "./string-only"'
// import "./line-comment-only"
/* export * from "./block-comment-only" */
const load = () => import("./dynamic")
`;
  const staticExpected = [
    "./static-default",
    "./static-named",
    "./static-export",
    "./static-all",
    "./side-effect",
  ];
  const staticSpecifiers = staticRuntimeModuleSpecifiers(fixture);
  const dynamicSpecifiers = staticRuntimeModuleSpecifiers(fixture, {
    includeDynamic: true,
  });
  const allSpecifiers = allModuleSpecifiers(fixture, { includeDynamic: true });
  const failures = [];
  if (JSON.stringify(staticSpecifiers) !== JSON.stringify(staticExpected)) {
    failures.push("dependency parser self-test failed for semicolonless static imports and exports");
  }
  if (
    JSON.stringify(dynamicSpecifiers) !== JSON.stringify([...staticExpected, "./dynamic"])
  ) {
    failures.push("dependency parser self-test failed for dynamic import opt-in");
  }
  for (const specifier of [
    "./string-only",
    "./line-comment-only",
    "./block-comment-only",
  ]) {
    if (allSpecifiers.includes(specifier)) {
      failures.push(`dependency parser self-test accepted a non-import (${specifier})`);
    }
  }
  if (
    !allSpecifiers.includes("./type-only-import")
    || !allSpecifiers.includes("./type-only-export")
    || staticSpecifiers.includes("./type-only-import")
    || staticSpecifiers.includes("./type-only-export")
  ) {
    failures.push("dependency parser self-test failed for type-only import filtering");
  }
  return failures;
}

export function cyclicDependencyComponents(graph) {
  let cursor = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const stacked = new Set();
  const components = [];

  function visit(node) {
    indices.set(node, cursor);
    lowLinks.set(node, cursor);
    cursor += 1;
    stack.push(node);
    stacked.add(node);
    for (const dependency of graph.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)));
      } else if (stacked.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(dependency)));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      stacked.delete(member);
      component.push(member);
      if (member === node) break;
    }
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) {
      components.push(component.sort());
    }
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) visit(node);
  }
  return components.sort((left, right) => (
    left.join("\n").localeCompare(right.join("\n"))
  ));
}
