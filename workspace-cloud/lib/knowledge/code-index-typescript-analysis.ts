import ts from "@typescript/typescript6";

import type {
  CodeFileAnalysis,
  CodeReference,
  CodeSymbol,
} from "./code-index-core";
import {
  boundedCodeIndexName,
  cleanCodeIndexText,
  safeCodeIndexSignature,
} from "./code-index-text";

const MAX_SYMBOLS_PER_FILE = 500;
const MAX_REFERENCES_PER_FILE = 1_000;
type CodeNodeKind = CodeSymbol["kind"];
type CodeRelation = CodeReference["relation"];

function lineRange(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = sourceFile
    .getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(
    Math.max(node.getStart(sourceFile), node.end - 1),
  ).line + 1;
  return { lineStart: start, lineEnd: Math.max(start, end) };
}

function nodeName(node: ts.NamedDeclaration, sourceFile: ts.SourceFile) {
  const name = node.name;
  if (!name) return null;
  const value = ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : name.getText(sourceFile);
  const cleaned = boundedCodeIndexName(value);
  return /^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(cleaned) ? cleaned : null;
}

function expressionName(node: ts.Expression, sourceFile: ts.SourceFile) {
  const value = cleanCodeIndexText(node.getText(sourceFile), 256);
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.:][A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value)
    ? value
    : null;
}

function literalValue(node: ts.Expression | undefined) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? cleanCodeIndexText(node.text, 512)
    : null;
}

import { parseSqlReferences } from "./code-index-sql-references";

function nextRoutePath(path: string) {
  const segments = path.split("/");
  const routeFile = segments.at(-1)?.match(/^route\.[cm]?[jt]sx?$/);
  if (!routeFile) return null;
  const appIndex = segments.lastIndexOf("app", segments.length - 2);
  if (appIndex < 0) return null;
  const routeSegments = segments.slice(appIndex + 1, -1)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !segment.startsWith("@"))
    .map((segment) => {
      const optionalCatchAll = segment.match(/^\[\[\.\.\.([^\]]+)\]\]$/)?.[1];
      if (optionalCatchAll) return `*${optionalCatchAll}`;
      const catchAll = segment.match(/^\[\.\.\.([^\]]+)\]$/)?.[1];
      if (catchAll) return `*${catchAll}`;
      const dynamic = segment.match(/^\[([^\]]+)\]$/)?.[1];
      return dynamic ? `:${dynamic}` : segment;
    });
  return `/${routeSegments.join("/")}`;
}

export function analyzeTypeScriptCodeFile(
  path: string,
  source: string,
  language: string,
): CodeFileAnalysis {
  const scriptKind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : path.match(/\.[cm]?js$/)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const symbols: CodeSymbol[] = [];
  const references: CodeReference[] = [];
  const addSymbol = (kind: CodeNodeKind, name: string, node: ts.Node) => {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) return null;
    const range = lineRange(sourceFile, node);
    symbols.push({
      kind,
      name,
      ...range,
      signature: safeCodeIndexSignature(node.getText(sourceFile)) || name,
    });
    return symbols.length - 1;
  };
  const addReference = (
    ownerIndex: number | null,
    relation: CodeRelation,
    targetKind: CodeNodeKind,
    targetName: string,
    node: ts.Node,
  ) => {
    if (references.length >= MAX_REFERENCES_PER_FILE) return;
    const name = boundedCodeIndexName(targetName);
    if (!name) return;
    references.push({
      ownerIndex,
      relation,
      targetKind,
      targetName: name,
      ...lineRange(sourceFile, node),
    });
  };

  const visit = (node: ts.Node, inheritedOwner: number | null) => {
    let owner = inheritedOwner;
    if (
      ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)
      || ts.isMethodSignature(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node)
    ) {
      const name = nodeName(node, sourceFile);
      if (name) owner = addSymbol("function", name, node) ?? owner;
    } else if (
      ts.isClassDeclaration(node)
      || ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node)
      || ts.isEnumDeclaration(node)
    ) {
      const name = nodeName(node, sourceFile);
      if (name) owner = addSymbol("type", name, node) ?? owner;
    } else if (ts.isModuleDeclaration(node)) {
      const name = nodeName(node, sourceFile);
      if (name) owner = addSymbol("module", name, node) ?? owner;
    } else if (
      ts.isVariableDeclaration(node)
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const name = nodeName(node, sourceFile);
      if (name) owner = addSymbol("function", name, node) ?? owner;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const target = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : null;
      if (target) addReference(owner, "imports", "module", target, node);
    }
    if (ts.isCallExpression(node)) {
      const target = expressionName(node.expression, sourceFile);
      if (target) {
        addReference(owner, "calls", "function", target, node);
        const method = target.split(/[.:]/).at(-1)?.toLowerCase();
        const first = literalValue(node.arguments[0]);
        if (
          first && method
          && ["get", "post", "put", "patch", "delete"].includes(method)
          && first.startsWith("/")
        ) {
          addReference(owner, "handles_route", "route", `${method.toUpperCase()} ${first}`, node);
        }
        if (first && method && ["track", "emit", "publish", "capture"].includes(method)) {
          addReference(owner, "emits_event", "event", first, node);
        }
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const range = lineRange(sourceFile, node);
      for (const reference of parseSqlReferences(
        node.text,
        owner,
        range.lineStart,
        range.lineEnd,
      )) {
        if (references.length < MAX_REFERENCES_PER_FILE) references.push(reference);
      }
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  };
  visit(sourceFile, null);
  const routePath = nextRoutePath(path);
  if (routePath) {
    for (let index = 0; index < symbols.length; index += 1) {
      const symbol = symbols[index]!;
      const method = symbol.name.toUpperCase();
      if (
        references.length < MAX_REFERENCES_PER_FILE
        && ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)
      ) {
        references.push({
          ownerIndex: index,
          relation: "handles_route",
          targetKind: "route",
          targetName: `${method} ${routePath}`,
          lineStart: symbol.lineStart,
          lineEnd: symbol.lineEnd,
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    language,
    lineCount: Math.max(
      1,
      sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1,
    ),
    symbols,
    references,
  };
}
