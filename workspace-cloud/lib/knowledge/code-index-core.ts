import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "@typescript/typescript6";

import {
  validateGraphBuildArtifact,
  type ValidGraphArtifact,
} from "./artifact-core";

export const CODE_INDEX_EXTRACTOR_ID = "dopedb.code-index";
export const CODE_INDEX_EXTRACTOR_VERSION = "1.0.0";
export const MAX_CODE_INDEX_FILE_BYTES = 1024 * 1024;
export const MAX_CODE_INDEX_FILES = 20_000;
export const MAX_CODE_INDEX_ENTITIES = 100_000;

const MAX_SYMBOLS_PER_FILE = 500;
const MAX_REFERENCES_PER_FILE = 1_000;
const MAX_ATTRIBUTE_CHARS = 4_000;

type CodeNodeKind =
  | "module"
  | "type"
  | "function"
  | "route"
  | "table"
  | "column"
  | "migration"
  | "event";

type CodeRelation =
  | "imports"
  | "calls"
  | "handles_route"
  | "reads_table"
  | "writes_table"
  | "emits_event";

export type CodeSymbol = {
  kind: CodeNodeKind;
  name: string;
  lineStart: number;
  lineEnd: number;
  signature: string;
};

export type CodeReference = {
  ownerIndex: number | null;
  relation: CodeRelation;
  targetKind: CodeNodeKind;
  targetName: string;
  lineStart: number;
  lineEnd: number;
};

export type CodeFileAnalysis = {
  schemaVersion: 1;
  language: string;
  lineCount: number;
  symbols: CodeSymbol[];
  references: CodeReference[];
};

export type CodeIndexArtifactFile = {
  path: string;
  blobSha: string;
  bytes: number;
  language: string;
  analysis: CodeFileAnalysis | null;
};

type ArtifactInput = {
  sourceId: string;
  projectId: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  displayName: string;
  repositoryId: string;
  repository: string;
  refName: string;
  commitSha: string;
  parentGraphRevisionId: string | null;
  changedFiles: string[];
  generatedAt: string;
  files: CodeIndexArtifactFile[];
};

const EXTENSION_LANGUAGE = new Map([
  ["c", "c"], ["cc", "cpp"], ["cjs", "javascript"], ["cpp", "cpp"],
  ["cs", "csharp"], ["go", "go"], ["h", "c"], ["hpp", "cpp"],
  ["java", "java"], ["js", "javascript"], ["json", "json"],
  ["jsx", "javascript"], ["kt", "kotlin"], ["kts", "kotlin"],
  ["md", "markdown"], ["mdx", "markdown"], ["mjs", "javascript"],
  ["php", "php"], ["proto", "protobuf"], ["py", "python"], ["rb", "ruby"],
  ["rs", "rust"], ["sh", "shell"], ["sql", "sql"], ["svelte", "svelte"],
  ["swift", "swift"], ["toml", "toml"], ["ts", "typescript"],
  ["tsx", "typescript"], ["vue", "vue"], ["yaml", "yaml"], ["yml", "yaml"],
]);

export function codeLanguageForPath(path: string) {
  const fileName = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (fileName === "dockerfile" || fileName.startsWith("dockerfile.")) return "dockerfile";
  const extension = fileName.includes(".") ? fileName.split(".").at(-1) ?? "" : "";
  return EXTENSION_LANGUAGE.get(extension) ?? null;
}

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value: string, maximum = MAX_ATTRIBUTE_CHARS) {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.slice(0, maximum).trim();
}

function safeSignature(value: string) {
  const header = value.split(/=>|[\n\r{]/, 1)[0] ?? value;
  const redacted = header.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "$1…$1");
  return clean(redacted, 1_024);
}

function boundedName(value: string) {
  return clean(value, 512);
}

function safeArtifactPath(value: string) {
  return value.length > 0
    && value.length <= 4_096
    && !value.startsWith("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(value)
    && value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function lineRange(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(Math.max(node.getStart(sourceFile), node.end - 1)).line + 1;
  return { lineStart: start, lineEnd: Math.max(start, end) };
}

function nodeName(node: ts.NamedDeclaration, sourceFile: ts.SourceFile) {
  const name = node.name;
  if (!name) return null;
  const value = ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : name.getText(sourceFile);
  const cleaned = boundedName(value);
  return /^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(cleaned) ? cleaned : null;
}

function expressionName(node: ts.Expression, sourceFile: ts.SourceFile) {
  const value = clean(node.getText(sourceFile), 256);
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.:][A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value)
    ? value
    : null;
}

function literalValue(node: ts.Expression | undefined) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? clean(node.text, 512)
    : null;
}

function parseSqlReferences(
  text: string,
  ownerIndex: number | null,
  lineStart: number,
  lineEnd: number,
) {
  const references: CodeReference[] = [];
  const seen = new Set<string>();
  const add = (relation: CodeRelation, value: string) => {
    const name = boundedName(value.replace(/["'`]/g, ""));
    const key = `${relation}\0${name}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    references.push({
      ownerIndex,
      relation,
      targetKind: "table",
      targetName: name,
      lineStart,
      lineEnd,
    });
  };
  for (const match of text.matchAll(/\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_."`]*)/gi)) {
    if (match[1]) add("reads_table", match[1]);
  }
  for (const match of text.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+([A-Za-z_][A-Za-z0-9_."`]*)/gi)) {
    if (match[1]) add("writes_table", match[1]);
  }
  return references;
}

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

function typescriptAnalysis(path: string, source: string, language: string): CodeFileAnalysis {
  const scriptKind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : path.match(/\.[cm]?js$/)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const symbols: CodeSymbol[] = [];
  const references: CodeReference[] = [];

  const addSymbol = (kind: CodeNodeKind, name: string, node: ts.Node) => {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) return null;
    const range = lineRange(sourceFile, node);
    const raw = node.getText(sourceFile);
    const symbol: CodeSymbol = {
      kind,
      name,
      ...range,
      signature: safeSignature(raw) || name,
    };
    symbols.push(symbol);
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
    const name = boundedName(targetName);
    if (!name) return;
    references.push({ ownerIndex, relation, targetKind, targetName: name, ...lineRange(sourceFile, node) });
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
    } else if (ts.isVariableDeclaration(node) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
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
        if (first && method && ["get", "post", "put", "patch", "delete"].includes(method)
          && first.startsWith("/")) {
          addReference(owner, "handles_route", "route", `${method.toUpperCase()} ${first}`, node);
        }
        if (first && method && ["track", "emit", "publish", "capture"].includes(method)) {
          addReference(owner, "emits_event", "event", first, node);
        }
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const range = lineRange(sourceFile, node);
      for (const reference of parseSqlReferences(node.text, owner, range.lineStart, range.lineEnd)) {
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
    lineCount: Math.max(1, sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1),
    symbols,
    references,
  };
}

type DefinitionPattern = { kind: CodeNodeKind; expression: RegExp };

function definitionPatterns(language: string): DefinitionPattern[] {
  if (language === "rust") return [
    { kind: "function", expression: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: "type", expression: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: "module", expression: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ];
  if (language === "python") return [
    { kind: "function", expression: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: "type", expression: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ];
  if (language === "go") return [
    { kind: "function", expression: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: "type", expression: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)\b/ },
  ];
  if (language === "kotlin") return [
    { kind: "function", expression: /^\s*(?:(?:public|private|protected|internal|open|final|override|suspend|inline|operator|infix|tailrec|external)\s+)*fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: "type", expression: /^\s*(?:(?:public|private|protected|internal|open|final|sealed|data|enum|annotation)\s+)*(?:class|interface|object)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ];
  if (language === "swift") return [
    { kind: "function", expression: /^\s*(?:(?:public|private|fileprivate|internal|open|static|class|mutating|nonmutating|override|final)\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: "type", expression: /^\s*(?:(?:public|private|fileprivate|internal|open|final|indirect)\s+)*(?:class|struct|enum|protocol|actor)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ];
  if (["java", "csharp"].includes(language)) return [
    { kind: "function", expression: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|async|virtual|override|sealed|partial|extern|unsafe|new)\s+)*(?:<[^>]+>\s*)?[A-Za-z_][A-Za-z0-9_<>,.?\[\]:]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: "type", expression: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*(?:class|struct|enum|interface|record)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ];
  if (["c", "cpp"].includes(language)) return [
    { kind: "function", expression: /^\s*(?:(?:static|inline|extern|virtual|constexpr|consteval|friend|explicit|unsigned|signed|long|short|const|volatile)\s+)*(?:[A-Za-z_][A-Za-z0-9_:<>,]*\s*[*&]?\s*)+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:\{|$)/ },
    { kind: "type", expression: /^\s*(?:typedef\s+)?(?:class|struct|enum|union)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ];
  if (language === "php") return [
    { kind: "function", expression: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*(?:async\s+)?function\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: "type", expression: /^\s*(?:(?:final|abstract|readonly)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ];
  if (language === "ruby") return [
    { kind: "function", expression: /^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/ },
    { kind: "type", expression: /^\s*(?:class|module)\s+([A-Za-z_][A-Za-z0-9_:]*)/ },
  ];
  if (language === "protobuf") return [
    { kind: "function", expression: /^\s*rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: "type", expression: /^\s*(?:message|enum|service)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ];
  if (language === "shell") return [
    { kind: "function", expression: /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*\{/ },
  ];
  return [];
}

const GENERIC_CALL_LANGUAGES = new Set([
  "c", "cpp", "csharp", "go", "java", "kotlin", "php", "python", "ruby", "rust",
  "shell", "swift",
]);
const CALL_KEYWORDS = new Set([
  "catch", "class", "def", "else", "enum", "for", "foreach", "func", "function", "if",
  "interface", "match", "return", "sizeof", "struct", "switch", "trait", "type", "while",
]);

function genericAnalysis(source: string, language: string): CodeFileAnalysis {
  const lines = source.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];
  const references: CodeReference[] = [];
  const patterns = definitionPatterns(language);
  const addSymbol = (kind: CodeNodeKind, name: string, line: string, lineNumber: number) => {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    symbols.push({
      kind,
      name,
      lineStart: lineNumber,
      lineEnd: lineNumber,
      signature: safeSignature(line) || name,
    });
  };
  const addReference = (relation: CodeRelation, targetKind: CodeNodeKind, name: string, line: number) => {
    if (references.length >= MAX_REFERENCES_PER_FILE) return;
    const targetName = boundedName(name);
    if (targetName) references.push({
      ownerIndex: null,
      relation,
      targetKind,
      targetName,
      lineStart: line,
      lineEnd: line,
    });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    const definedNames = new Set<string>();
    for (const pattern of patterns) {
      const match = line.match(pattern.expression);
      if (match?.[1]) {
        addSymbol(pattern.kind, match[1], line, lineNumber);
        definedNames.add(match[1]);
      }
    }
    if (language === "markdown") {
      const heading = line.match(/^#{1,6}\s+(.+)/)?.[1];
      if (heading) addSymbol("module", boundedName(heading), line, lineNumber);
    }
    if (["json", "yaml", "toml"].includes(language)) {
      const key = line.match(/^\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]/)?.[1];
      if (key) addSymbol("module", key, line, lineNumber);
    }
    const importTarget = language === "rust"
      ? line.match(/^\s*use\s+([^;]+);/)?.[1]
      : language === "python"
        ? line.match(/^\s*(?:from\s+([^\s]+)\s+import|import\s+([^\s,]+))/)?.slice(1).find(Boolean)
        : line.match(/^\s*(?:import|require|include)\s*(?:\(?["'<])?([^"'>);\s]+)/)?.[1];
    if (importTarget) addReference("imports", "module", importTarget, lineNumber);
    if (GENERIC_CALL_LANGUAGES.has(language)) {
      for (const match of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::|->)[A-Za-z_][A-Za-z0-9_]*)?)\s*\(/g)) {
        const target = match[1];
        const shortName = target?.split(/\.|::|->/).at(-1) ?? "";
        if (target && shortName && !definedNames.has(shortName) && !CALL_KEYWORDS.has(shortName)) {
          addReference("calls", "function", target, lineNumber);
        }
      }
      for (const match of line.matchAll(/\b(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) {
        if (match[1] && match[2]?.startsWith("/")) {
          addReference("handles_route", "route", `${match[1].toUpperCase()} ${match[2]}`, lineNumber);
        }
      }
      for (const match of line.matchAll(/\b(?:track|emit|publish|capture)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) {
        if (match[1]) addReference("emits_event", "event", match[1], lineNumber);
      }
    }
  }
  for (const reference of parseSqlReferences(source, null, 1, Math.max(1, lines.length))) {
    if (references.length < MAX_REFERENCES_PER_FILE) references.push(reference);
  }
  if (language === "sql") {
    for (const match of source.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][A-Za-z0-9_."`]*)/gi)) {
      if (match[1]) addSymbol("table", match[1].replace(/["`]/g, ""), match[0], 1);
    }
  }
  return {
    schemaVersion: 1,
    language,
    lineCount: Math.max(1, lines.length),
    symbols,
    references,
  };
}

export function analyzeCodeFile(path: string, bytes: Uint8Array): CodeFileAnalysis | null {
  if (!safeArtifactPath(path)) return null;
  const language = codeLanguageForPath(path);
  if (!language || bytes.byteLength > MAX_CODE_INDEX_FILE_BYTES) return null;
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (source.includes("\0")) return null;
  return language === "typescript" || language === "javascript"
    ? typescriptAnalysis(path, source, language)
    : genericAnalysis(source, language);
}

function uuidFromHash(value: string) {
  const bytes = Buffer.from(hash(value).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildCodeIndexArtifact(input: ArtifactInput): ValidGraphArtifact {
  const files = [...input.files].sort((left, right) => left.path.localeCompare(right.path));
  if (files.length > MAX_CODE_INDEX_FILES) throw new Error("Code index file limit exceeded");
  const entityCount = files.reduce((total, file) => total
    + (file.analysis?.symbols.length ?? 0)
    + (file.analysis?.references.length ?? 0), files.length);
  if (entityCount > MAX_CODE_INDEX_ENTITIES) {
    throw new Error("Code index entity limit exceeded");
  }
  const sourceRevisionSha256 = hash(files.map((file) =>
    `${file.path}\0${file.blobSha}\0${file.bytes}`
  ).join("\n"));
  const graphRevisionId = uuidFromHash([
    input.sourceId,
    input.projectEnvironmentId,
    String(input.environmentRevision),
    sourceRevisionSha256,
    input.parentGraphRevisionId ?? "root",
  ].join("\0"));
  const nodes = new Map<string, Record<string, unknown>>();
  const edges = new Map<string, Record<string, unknown>>();
  const evidence = new Map<string, Record<string, unknown>>();
  const fileNodeIds = new Map<string, string>();
  const symbolsByFile = new Map<string, string[]>();
  const symbolIdsByName = new Map<string, string[]>();
  const filePaths = new Set(files.map((file) => file.path));

  const resolveImport = (fromPath: string, target: string) => {
    if (!target.startsWith(".")) return null;
    const base = posix.normalize(posix.join(posix.dirname(fromPath), target));
    if (!safeArtifactPath(base)) return null;
    const extensions = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "rs", "py", "go"];
    const candidates = [
      base,
      ...extensions.map((extension) => `${base}.${extension}`),
      ...extensions.map((extension) => `${base}/index.${extension}`),
    ];
    return candidates.find((candidate) => filePaths.has(candidate)) ?? null;
  };

  const addNode = (
    kind: string,
    name: string,
    qualifiedName: string,
    attributes?: Record<string, string>,
  ) => {
    const id = hash(`node\0${input.sourceId}\0${kind}\0${qualifiedName}`);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind,
        name: boundedName(name),
        qualifiedName: clean(qualifiedName, 16_000),
        ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}),
      });
    }
    return id;
  };
  const addEdge = (
    from: string,
    to: string,
    relation: string,
    path: string,
    lineStart: number,
    lineEnd: number,
  ) => {
    const evidenceId = hash([
      "evidence", sourceRevisionSha256, path, String(lineStart), String(lineEnd), relation, from, to,
    ].join("\0"));
    evidence.set(evidenceId, {
      id: evidenceId,
      sourceId: input.sourceId,
      sourceRevisionSha256,
      filePath: path,
      lineStart,
      lineEnd,
      extractionMethod: "dopedb_code_index",
      observedAt: input.generatedAt,
    });
    const edgeId = hash(`edge\0${from}\0${to}\0${relation}\0${evidenceId}`);
    edges.set(edgeId, {
      id: edgeId,
      from,
      to,
      relation,
      state: "EXTRACTED",
      evidenceIds: [evidenceId],
    });
  };

  for (const file of files) {
    const analysis = file.analysis;
    const lineEnd = analysis?.lineCount ?? 1;
    const fileId = addNode("file", file.path.split("/").at(-1) ?? file.path, file.path, {
      language: file.language,
      path: file.path,
      blobSha: file.blobSha,
      lineStart: "1",
      lineEnd: String(lineEnd),
    });
    fileNodeIds.set(file.path, fileId);
    const symbolIds: string[] = [];
    for (const symbol of analysis?.symbols ?? []) {
      const qualifiedName = `${file.path}#${symbol.name}:${symbol.lineStart}`;
      const symbolId = addNode(symbol.kind, symbol.name, qualifiedName, {
        language: analysis!.language,
        path: file.path,
        lineStart: String(symbol.lineStart),
        lineEnd: String(symbol.lineEnd),
        signature: symbol.signature,
      });
      symbolIds.push(symbolId);
      const named = symbolIdsByName.get(symbol.name) ?? [];
      named.push(symbolId);
      symbolIdsByName.set(symbol.name, named);
      addEdge(fileId, symbolId, "defines", file.path, symbol.lineStart, symbol.lineEnd);
    }
    symbolsByFile.set(file.path, symbolIds);
  }

  for (const file of files) {
    if (!file.analysis) continue;
    const fileNodeId = hash(`node\0${input.sourceId}\0file\0${file.path}`);
    const symbolIds = symbolsByFile.get(file.path) ?? [];
    for (const reference of file.analysis.references) {
      const from = reference.ownerIndex === null
        ? fileNodeId
        : symbolIds[reference.ownerIndex] ?? fileNodeId;
      let to: string;
      if (reference.relation === "calls") {
        const shortName = reference.targetName.split(/[.:]/).at(-1) ?? reference.targetName;
        const candidates = symbolIdsByName.get(shortName) ?? [];
        to = reference.targetName === shortName && candidates.length === 1
          ? candidates[0]!
          : addNode("function", reference.targetName, `call:${reference.targetName}`);
      } else if (reference.relation === "imports") {
        const resolvedPath = resolveImport(file.path, reference.targetName);
        to = resolvedPath
          ? fileNodeIds.get(resolvedPath)!
          : addNode("module", reference.targetName, `module:${reference.targetName}`);
      } else {
        const prefix = reference.targetKind === "module" ? "module" : reference.targetKind;
        to = addNode(reference.targetKind, reference.targetName, `${prefix}:${reference.targetName}`);
      }
      addEdge(
        from,
        to,
        reference.relation,
        file.path,
        reference.lineStart,
        reference.lineEnd,
      );
    }
  }

  const changedFiles = [...new Set(input.changedFiles.filter(safeArtifactPath))].sort();
  const artifact = {
    schemaVersion: 1,
    graphRevisionId,
    environmentRevision: input.environmentRevision,
    binding: {
      sourceId: input.sourceId,
      projectId: input.projectId,
      projectEnvironmentId: input.projectEnvironmentId,
      provider: "github",
      displayName: input.displayName,
      visibility: "shared_graph",
      revision: {
        kind: "github",
        repository_id: input.repositoryId,
        repository: input.repository,
        ref_name: input.refName,
        commit_sha: input.commitSha,
      },
    },
    sourceRevisionSha256,
    parentGraphRevisionId: input.parentGraphRevisionId,
    extractor: {
      id: CODE_INDEX_EXTRACTOR_ID,
      version: CODE_INDEX_EXTRACTOR_VERSION,
      sourceSha256: hash(`${CODE_INDEX_EXTRACTOR_ID}\0${CODE_INDEX_EXTRACTOR_VERSION}`),
    },
    generatedAt: input.generatedAt,
    health: {
      complete: true,
      parsedFiles: files.filter((file) => file.analysis !== null).length,
      skippedFiles: files.filter((file) => file.analysis === null).length,
      failedFiles: 0,
    },
    changedFiles: changedFiles.length > 0 || input.parentGraphRevisionId !== null
      ? changedFiles
      : files.map((file) => file.path),
    nodes: [...nodes.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
    edges: [...edges.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
    evidence: [...evidence.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
  };
  const validated = validateGraphBuildArtifact(artifact);
  if (!validated) throw new Error("Code index artifact failed validation");
  return validated.artifact;
}

export function validateCodeFileAnalysis(value: unknown): value is CodeFileAnalysis {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const analysis = value as Partial<CodeFileAnalysis>;
  return analysis.schemaVersion === 1
    && typeof analysis.language === "string"
    && Number.isSafeInteger(analysis.lineCount)
    && (analysis.lineCount ?? 0) > 0
    && Array.isArray(analysis.symbols)
    && analysis.symbols.length <= MAX_SYMBOLS_PER_FILE
    && Array.isArray(analysis.references)
    && analysis.references.length <= MAX_REFERENCES_PER_FILE;
}
