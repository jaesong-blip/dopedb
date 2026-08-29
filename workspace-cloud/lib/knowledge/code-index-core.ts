import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  validateGraphBuildArtifact,
  type ValidGraphArtifact,
} from "./artifact-core";
import { analyzeTypeScriptCodeFile } from "./code-index-typescript-analysis";
import {
  boundedCodeIndexName as boundedName,
  cleanCodeIndexText as clean,
  safeCodeIndexSignature as safeSignature,
} from "./code-index-text";

export const CODE_INDEX_EXTRACTOR_ID = "dopedb.code-index";
export const CODE_INDEX_EXTRACTOR_VERSION = "1.0.0";
export const MAX_CODE_INDEX_FILE_BYTES = 1024 * 1024;
export const MAX_CODE_INDEX_FILES = 20_000;
export const MAX_CODE_INDEX_ENTITIES = 100_000;

export function codeIndexManifestWindow(
  totalFiles: number,
  checkpointFiles: number,
  batchSize: number,
) {
  if (
    !Number.isSafeInteger(totalFiles)
    || totalFiles < 0
    || totalFiles > MAX_CODE_INDEX_FILES
    || !Number.isSafeInteger(checkpointFiles)
    || checkpointFiles < 0
    || checkpointFiles > totalFiles
    || !Number.isSafeInteger(batchSize)
    || batchSize < 1
  ) {
    throw new Error("Invalid code-index manifest checkpoint");
  }
  return {
    start: checkpointFiles,
    end: Math.min(checkpointFiles + batchSize, totalFiles),
    complete: checkpointFiles === totalFiles,
  };
}

export type CodeIndexCronPhase = "manifest" | "indexing" | "activating";

export const CODE_INDEX_PHASE_START_BUDGET_MS: Readonly<Record<CodeIndexCronPhase, number>> = {
  manifest: 18_000,
  indexing: 28_000,
  activating: 30_000,
};

export function codeIndexPhaseHasStartBudget(
  phase: CodeIndexCronPhase,
  remainingMs: number,
) {
  return Number.isFinite(remainingMs)
    && remainingMs >= CODE_INDEX_PHASE_START_BUDGET_MS[phase];
}

export function codeIndexQueryTimeoutMs(
  remainingMs: number,
  maximumTimeoutMs = 20_000,
  cleanupReserveMs = 5_000,
) {
  if (
    !Number.isFinite(remainingMs)
    || !Number.isSafeInteger(maximumTimeoutMs)
    || maximumTimeoutMs < 1_000
    || !Number.isSafeInteger(cleanupReserveMs)
    || cleanupReserveMs < 0
  ) return null;
  const available = Math.floor(remainingMs - cleanupReserveMs);
  return available >= 1_000 ? Math.min(maximumTimeoutMs, available) : null;
}

const MAX_SYMBOLS_PER_FILE = 500;
const MAX_REFERENCES_PER_FILE = 1_000;

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

export type CodeIndexArtifactInput = {
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
  revisionManifest?: Array<{ path: string; blobSha: string; bytes: number }>;
  exactSourceRevisionSha256?: string;
  externalUniqueSymbols?: Array<{
    name: string;
    path: string;
    language: string;
    lineStart: number;
    lineEnd: number;
    signature: string;
  }>;
  globallyAmbiguousCallNames?: string[];
};

type ArtifactInput = CodeIndexArtifactInput;

export type CodeIndexArtifactFragmentInput = Omit<CodeIndexArtifactInput, "files"> & {
  files: CodeIndexArtifactFile[];
  completeFileManifest: Array<{ path: string; blobSha: string; bytes: number }>;
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

export function codeIndexSourceRevisionSha256(
  manifest: ReadonlyArray<{ path: string; blobSha: string; bytes: number }>,
) {
  return hash([...manifest]
    .sort((left, right) => compareCodeIndexPath(left.path, right.path))
    .map((file) => `${file.path}\0${file.blobSha}\0${file.bytes}`)
    .join("\n"));
}

export function compareCodeIndexPath(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function safeArtifactPath(value: string) {
  return value.length > 0
    && value.length <= 4_096
    && !value.startsWith("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    && value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
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
    ? analyzeTypeScriptCodeFile(path, source, language)
    : genericAnalysis(source, language);
}

function uuidFromHash(value: string) {
  const bytes = Buffer.from(hash(value).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function codeIndexGraphRevisionId(input: {
  sourceId: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  sourceRevisionSha256: string;
  parentGraphRevisionId: string | null;
}) {
  if (!/^[0-9a-f]{64}$/.test(input.sourceRevisionSha256)) {
    throw new Error("Invalid exact code-index source revision");
  }
  return uuidFromHash([
    input.sourceId,
    input.projectEnvironmentId,
    String(input.environmentRevision),
    input.sourceRevisionSha256,
    input.parentGraphRevisionId ?? "root",
  ].join("\0"));
}

export function buildCodeIndexArtifact(input: ArtifactInput): ValidGraphArtifact {
  const files = [...input.files].sort((left, right) => compareCodeIndexPath(left.path, right.path));
  if (files.length > MAX_CODE_INDEX_FILES) throw new Error("Code index file limit exceeded");
  const entityCount = files.reduce((total, file) => total
    + (file.analysis?.symbols.length ?? 0)
    + (file.analysis?.references.length ?? 0), files.length);
  if (entityCount > MAX_CODE_INDEX_ENTITIES) {
    throw new Error("Code index entity limit exceeded");
  }
  const revisionManifest = [...(input.revisionManifest ?? files)]
    .sort((left, right) => compareCodeIndexPath(left.path, right.path));
  const sourceRevisionSha256 = input.exactSourceRevisionSha256
    ?? codeIndexSourceRevisionSha256(revisionManifest);
  if (!/^[0-9a-f]{64}$/.test(sourceRevisionSha256)) {
    throw new Error("Invalid exact code-index source revision");
  }
  const graphRevisionId = codeIndexGraphRevisionId({
    sourceId: input.sourceId,
    projectEnvironmentId: input.projectEnvironmentId,
    environmentRevision: input.environmentRevision,
    sourceRevisionSha256,
    parentGraphRevisionId: input.parentGraphRevisionId,
  });
  const nodes = new Map<string, Record<string, unknown>>();
  const edges = new Map<string, Record<string, unknown>>();
  const evidence = new Map<string, Record<string, unknown>>();
  const fileNodeIds = new Map<string, string>();
  const symbolsByFile = new Map<string, string[]>();
  const symbolIdsByName = new Map<string, string[]>();
  const revisionFilesByPath = new Map(revisionManifest.map((file) => [file.path, file]));
  const filePaths = new Set(revisionFilesByPath.keys());
  const globallyAmbiguousCallNames = new Set(input.globallyAmbiguousCallNames ?? []);

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

  for (const symbol of input.externalUniqueSymbols ?? []) {
    if (!safeArtifactPath(symbol.path)) continue;
    const symbolId = addNode("function", symbol.name, `${symbol.path}#${symbol.name}:${symbol.lineStart}`, {
      language: symbol.language,
      path: symbol.path,
      lineStart: String(symbol.lineStart),
      lineEnd: String(symbol.lineEnd),
      signature: symbol.signature,
    });
    const named = symbolIdsByName.get(symbol.name) ?? [];
    named.push(symbolId);
    symbolIdsByName.set(symbol.name, named);
  }

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
        to = reference.targetName === shortName
          && !globallyAmbiguousCallNames.has(shortName)
          && candidates.length === 1
          ? candidates[0]!
          : addNode("function", reference.targetName, `call:${reference.targetName}`);
      } else if (reference.relation === "imports") {
        const resolvedPath = resolveImport(file.path, reference.targetName);
        to = resolvedPath
          ? fileNodeIds.get(resolvedPath) ?? addNode(
            "file",
            resolvedPath.split("/").at(-1) ?? resolvedPath,
            resolvedPath,
            {
              language: codeLanguageForPath(resolvedPath) ?? "unsupported",
              path: resolvedPath,
              blobSha: revisionFilesByPath.get(resolvedPath)?.blobSha ?? "0".repeat(40),
              lineStart: "1",
              lineEnd: "1",
            },
          )
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

export function buildCodeIndexArtifactFragment(
  input: CodeIndexArtifactFragmentInput,
): ValidGraphArtifact {
  const complete = [...input.completeFileManifest]
    .sort((left, right) => compareCodeIndexPath(left.path, right.path));
  if (complete.length > MAX_CODE_INDEX_FILES) throw new Error("Code index file limit exceeded");
  return buildCodeIndexArtifact({ ...input, revisionManifest: complete });
}

export function mergeCodeIndexArtifacts(input: {
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
  fragments: ValidGraphArtifact[];
}): ValidGraphArtifact {
  if (input.fragments.length < 1 || input.fragments.length > MAX_CODE_INDEX_FILES) {
    throw new Error("Invalid code index artifact fragments");
  }
  const nodes = new Map<string, Record<string, unknown>>();
  const edges = new Map<string, Record<string, unknown>>();
  const evidence = new Map<string, Record<string, unknown>>();
  const filePaths = new Set<string>();
  let parsedFiles = 0;
  let skippedFiles = 0;
  for (const fragment of input.fragments) {
    if (
      fragment.binding.sourceId !== input.sourceId
      || fragment.binding.projectId !== input.projectId
      || fragment.binding.projectEnvironmentId !== input.projectEnvironmentId
      || fragment.environmentRevision !== input.environmentRevision
      || fragment.parentGraphRevisionId !== input.parentGraphRevisionId
      || fragment.binding.revision.repository_id !== input.repositoryId
      || fragment.binding.revision.repository !== input.repository
      || fragment.binding.revision.ref_name !== input.refName
      || fragment.binding.revision.commit_sha !== input.commitSha
    ) throw new Error("Code index artifact fragment binding changed");
    const health = fragment.health as Record<string, unknown>;
    parsedFiles += Number(health.parsedFiles);
    skippedFiles += Number(health.skippedFiles);
    for (const node of fragment.nodes as Array<Record<string, unknown>>) {
      nodes.set(String(node.id), node);
      if (node.kind === "file") filePaths.add(String(node.qualifiedName));
    }
    for (const edge of fragment.edges as Array<Record<string, unknown>>) {
      edges.set(String(edge.id), edge);
    }
    for (const item of fragment.evidence as Array<Record<string, unknown>>) {
      evidence.set(String(item.id), item);
    }
  }
  if (filePaths.size !== parsedFiles + skippedFiles) {
    throw new Error("Code index artifact fragments are incomplete");
  }
  const template = input.fragments[0]!;
  const sourceRevisionSha256 = template.sourceRevisionSha256;
  if (input.fragments.some((fragment) =>
    fragment.sourceRevisionSha256 !== sourceRevisionSha256
    || fragment.graphRevisionId !== template.graphRevisionId
  )) throw new Error("Code index artifact fragment revision changed");
  const functionIdsByName = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (
      node.kind !== "function"
      || typeof node.name !== "string"
      || (typeof node.qualifiedName === "string" && node.qualifiedName.startsWith("call:"))
    ) continue;
    const ids = functionIdsByName.get(node.name) ?? [];
    ids.push(String(node.id));
    functionIdsByName.set(node.name, ids);
  }
  for (const [edgeId, edge] of [...edges]) {
    if (edge.relation !== "calls") continue;
    const target = nodes.get(String(edge.to));
    const targetName = typeof target?.name === "string" ? target.name : "";
    if (
      typeof target?.qualifiedName !== "string"
      || target.qualifiedName !== `call:${targetName}`
      || targetName.split(/[.:]/).at(-1) !== targetName
    ) continue;
    const candidates = functionIdsByName.get(targetName) ?? [];
    if (candidates.length !== 1) continue;
    const to = candidates[0]!;
    const evidenceId = Array.isArray(edge.evidenceIds) ? edge.evidenceIds[0] : null;
    const observed = typeof evidenceId === "string" ? evidence.get(evidenceId) : null;
    if (
      !observed
      || typeof observed.filePath !== "string"
      || !Number.isSafeInteger(observed.lineStart)
      || !Number.isSafeInteger(observed.lineEnd)
    ) continue;
    const nextEvidenceId = hash([
      "evidence",
      sourceRevisionSha256,
      observed.filePath,
      String(observed.lineStart),
      String(observed.lineEnd),
      "calls",
      String(edge.from),
      to,
    ].join("\0"));
    const nextEdgeId = hash(`edge\0${String(edge.from)}\0${to}\0calls\0${nextEvidenceId}`);
    evidence.delete(evidenceId);
    evidence.set(nextEvidenceId, { ...observed, id: nextEvidenceId });
    edges.delete(edgeId);
    edges.set(nextEdgeId, { ...edge, id: nextEdgeId, to, evidenceIds: [nextEvidenceId] });
  }
  const referencedNodeIds = new Set<string>();
  for (const edge of edges.values()) {
    referencedNodeIds.add(String(edge.from));
    referencedNodeIds.add(String(edge.to));
  }
  for (const [id, node] of [...nodes]) {
    if (
      typeof node.qualifiedName === "string"
      && node.qualifiedName.startsWith("call:")
      && !referencedNodeIds.has(id)
    ) nodes.delete(id);
  }
  const artifact = {
    ...template,
    sourceRevisionSha256,
    generatedAt: input.generatedAt,
    changedFiles: input.changedFiles.length > 0 || input.parentGraphRevisionId !== null
      ? [...new Set(input.changedFiles.filter(safeArtifactPath))].sort()
      : [...filePaths].sort(),
    health: { complete: true, parsedFiles, skippedFiles, failedFiles: 0 },
    nodes: [...nodes.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
    edges: [...edges.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
    evidence: [...evidence.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
  };
  const validated = validateGraphBuildArtifact(artifact);
  if (!validated) throw new Error("Merged code index artifact failed validation");
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
import { parseSqlReferences } from "./code-index-sql-references";
