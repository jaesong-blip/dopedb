// AST-level contract checks.  These deliberately inspect TypeScript structure instead of
// counting export names or comparing Rust source text, so optionality, nesting and enum drift
// are visible to CI before a renderer can consume a stale hand-written mirror.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

function parseProgram(source, file) {
  return parse(source, { sourceType: "module", plugins: ["typescript"], sourceFilename: file }).program;
}

function exported(program, name) {
  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.declaration?.id?.name === name) return statement.declaration;
  }
  return undefined;
}

function literal(node) {
  return node?.type === "TSLiteralType" ? node.literal.value : undefined;
}

function properties(declaration) {
  const object = declaration?.typeAnnotation;
  if (object?.type !== "TSTypeLiteral") return new Map();
  return new Map(object.members
    .filter((member) => member.type === "TSPropertySignature")
    .map((member) => [member.key.name ?? member.key.value, member]));
}

function typeName(node) {
  if (node?.type === "TSTypeReference") return node.typeName.name;
  return undefined;
}

function unionLiterals(declaration) {
  const union = declaration?.typeAnnotation;
  return union?.type === "TSUnionType" ? union.types.map(literal) : [];
}

function requireProperty(diagnostics, declaration, field, optional, label) {
  const property = properties(declaration).get(field);
  if (!property || Boolean(property.optional) !== optional) {
    diagnostics.push(`${label}.${field} must be ${optional ? "optional" : "required"}`);
  }
  return property;
}

function requireExactProperties(diagnostics, declaration, expected, label) {
  const actual = new Set(properties(declaration).keys());
  for (const field of expected) {
    if (!actual.has(field)) diagnostics.push(`${label}.${field} must be present`);
  }
  for (const field of actual) {
    if (!expected.includes(field)) diagnostics.push(`${label}.${field} is an unreviewed wire field`);
  }
}

function isNamed(member, name) {
  return typeName(member?.typeAnnotation?.typeAnnotation) === name;
}

function documentQueryDiagnostics(program) {
  const diagnostics = [];
  const declaration = exported(program, "DocumentQuery");
  const variants = declaration?.typeAnnotation?.type === "TSUnionType" ? declaration.typeAnnotation.types : [];
  const byTag = new Map();
  for (const variant of variants) {
    const op = variant.type === "TSTypeLiteral" ? properties({ typeAnnotation: variant }).get("op") : undefined;
    const tag = literal(op?.typeAnnotation?.typeAnnotation);
    if (!tag || byTag.has(tag)) diagnostics.push("DocumentQuery must use unique literal op tags");
    byTag.set(tag, { typeAnnotation: variant });
  }
  for (const tag of ["find", "aggregate", "count"]) {
    if (!byTag.has(tag)) diagnostics.push(`DocumentQuery must preserve internally tagged ${tag} variant`);
  }
  for (const tag of byTag.keys()) {
    if (!["find", "aggregate", "count"].includes(tag)) {
      diagnostics.push(`DocumentQuery.${String(tag)} is an unreviewed tagged variant`);
    }
  }
  const find = byTag.get("find");
  if (find) {
    requireExactProperties(diagnostics, find, ["op", "collection", "filter", "projection", "sort", "skip", "limit"], "DocumentQuery.find");
    requireProperty(diagnostics, find, "collection", false, "DocumentQuery.find");
    for (const field of ["filter", "projection", "sort", "skip", "limit"]) {
      requireProperty(diagnostics, find, field, true, "DocumentQuery.find");
    }
  }
  const aggregate = byTag.get("aggregate");
  if (aggregate) {
    requireExactProperties(diagnostics, aggregate, ["op", "collection", "pipeline"], "DocumentQuery.aggregate");
    requireProperty(diagnostics, aggregate, "collection", false, "DocumentQuery.aggregate");
    requireProperty(diagnostics, aggregate, "pipeline", false, "DocumentQuery.aggregate");
  }
  const count = byTag.get("count");
  if (count) {
    requireExactProperties(diagnostics, count, ["op", "collection", "filter"], "DocumentQuery.count");
    requireProperty(diagnostics, count, "collection", false, "DocumentQuery.count");
    requireProperty(diagnostics, count, "filter", true, "DocumentQuery.count");
  }
  return diagnostics;
}

function catalogDiagnostics(protocol, catalog) {
  const diagnostics = [];
  requireProperty(diagnostics, exported(protocol, "Namespace"), "comment", true, "Namespace");
  const kinds = new Set(unionLiterals(exported(protocol, "ObjectKind")));
  for (const kind of ["table", "view", "materialized_view", "routine", "sequence", "type", "trigger", "other"]) {
    if (!kinds.has(kind)) diagnostics.push(`ObjectKind must include ${kind}`);
  }
  const table = exported(catalog, "Table");
  for (const field of ["columns", "foreignKeys", "constraints", "indexes", "rowEstimate"]) {
    requireProperty(diagnostics, table, field, false, "Catalog.Table");
  }
  const object = exported(catalog, "DatabaseObject");
  for (const field of ["detail", "parent"]) requireProperty(diagnostics, object, field, true, "Catalog.DatabaseObject");
  return diagnostics;
}

function queryDiagnostics(model, generated, domain) {
  const diagnostics = [];
  const classification = exported(model, "Classification");
  for (const field of ["kind", "risk", "statementCount", "noWhere", "tables", "notes", "rollbackSafe"]) {
    requireProperty(diagnostics, classification, field, false, "Classification");
  }
  const inspection = exported(generated, "SqlInspection");
  requireExactProperties(diagnostics, inspection, ["classification", "report"], "SqlInspection");
  if (!isNamed(requireProperty(diagnostics, inspection, "classification", false, "SqlInspection"), "Classification")) {
    diagnostics.push("SqlInspection.classification must nest Classification");
  }
  if (!isNamed(requireProperty(diagnostics, inspection, "report", false, "SqlInspection"), "PreviewReport")) {
    diagnostics.push("SqlInspection.report must nest PreviewReport");
  }
  const proposal = exported(generated, "SqlOperationProposal");
  const proposalFields = ["operationId", "payloadHash", "state", "approvalRequired", "autoRun", "confirmationPhrase", "expiresAt", "classification", "preview"];
  requireExactProperties(diagnostics, proposal, proposalFields, "SqlOperationProposal");
  for (const field of proposalFields) {
    requireProperty(diagnostics, proposal, field, false, "SqlOperationProposal");
  }
  if (!isNamed(properties(proposal).get("classification"), "Classification")) diagnostics.push("SqlOperationProposal must nest Classification");
  if (!isNamed(properties(proposal).get("preview"), "PreviewReport")) diagnostics.push("SqlOperationProposal must nest PreviewReport");
  const reexports = new Map();
  for (const statement of domain.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.source) {
      for (const specifier of statement.specifiers) {
        reexports.set(`${statement.source.value}:${specifier.exported.name}`, specifier.local.name);
      }
    }
  }
  for (const name of ["RiskLevel", "Classification", "PreviewMode", "PreviewReport"]) {
    if (reexports.get(`../../ipc/generated/model:${name}`) !== name) {
      diagnostics.push(`Query domain must directly re-export model-generated ${name}`);
    }
  }
  for (const name of ["SqlInspection", "SqlOperationProposal"]) {
    if (reexports.get(`./generated/contracts:${name}`) !== name) {
      diagnostics.push(`Query domain must directly re-export receipt-generated ${name}`);
    }
  }
  return diagnostics;
}

export function validateContractSemantics({ root, facadePath = "src/ipc/types.ts", sources = {} }) {
  const read = (relative) => sources[relative] ?? readFileSync(path.join(root, relative), "utf8");
  const facade = parseProgram(read(facadePath), facadePath);
  const protocol = parseProgram(read("src/ipc/generated/protocol-contracts.ts"), "protocol-contracts.ts");
  const catalog = parseProgram(read("src/ipc/generated/catalog-feature-contracts.ts"), "catalog-feature-contracts.ts");
  const model = parseProgram(read("src/ipc/generated/model.ts"), "model.ts");
  const query = parseProgram(read("src/features/queries/generated/contracts.ts"), "query-contracts.ts");
  const domain = parseProgram(read("src/features/queries/domain.ts"), "query-domain.ts");
  const diagnostics = [
    ...documentQueryDiagnostics(model),
    ...catalogDiagnostics(protocol, catalog),
    ...queryDiagnostics(model, query, domain),
  ];
  const localCatalog = exported(facade, "CatalogObjectKind");
  if (localCatalog?.typeAnnotation?.type !== "TSIndexedAccessType") {
    diagnostics.push("CatalogObjectKind must be derived from generated DatabaseObject.kind, not a literal union");
  }
  return diagnostics;
}
