import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateContractSemantics } from "./semantic-contracts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const semantic = (sources = {}) => validateContractSemantics({ root, sources });

test("checked-in generated catalog, Query receipt, and DocumentQuery contracts are AST-semantic", () => {
  assert.deepEqual(semantic(), []);
});

test("catalog semantic check rejects an optional-field and enum-variant mutation", () => {
  const protocol = read("src/ipc/generated/protocol-contracts.ts")
    .replace("comment?: string | null", "comment: string | null")
    .replace(' | "trigger"', "");
  const diagnostics = semantic({ "src/ipc/generated/protocol-contracts.ts": protocol });
  assert.match(diagnostics.join("\n"), /Namespace.comment must be optional/);
  assert.match(diagnostics.join("\n"), /ObjectKind must include trigger/);
});

test("Query generated receipt check rejects nested, renamed, and added receipt fields", () => {
  const query = read("src/features/queries/generated/contracts.ts")
    .replace("classification: Classification, report: PreviewReport", "classification: PreviewReport, report: PreviewReport")
    .replace("payloadHash: string", "payload: string")
    .replace("expiresAt: string", "expiresAt: string, receiptRevision: number");
  const diagnostics = semantic({ "src/features/queries/generated/contracts.ts": query });
  assert.match(diagnostics.join("\n"), /SqlInspection.classification must nest Classification/);
  assert.match(diagnostics.join("\n"), /SqlOperationProposal.payloadHash must be required/);
  assert.match(diagnostics.join("\n"), /SqlOperationProposal.receiptRevision is an unreviewed wire field/);
});

test("DocumentQuery semantic check rejects serde tag, default, field, and variant drift", () => {
  const model = read("src/ipc/generated/model.ts")
    .replace('"op": "find"', '"op": "lookup"')
    .replace('"op": "count", collection: string, filter?:', '"op": "count", collection: string, filter:')
    .replace('"op": "aggregate", collection: string, pipeline: Array<JsonValue>, }', '"op": "aggregate", collection: string, pipeline: Array<JsonValue>, allowDiskUse: boolean, }')
    .replace('| { "op": "count"', '| { "op": "mapReduce", collection: string, } | { "op": "count"');
  const diagnostics = semantic({ "src/ipc/generated/model.ts": model });
  assert.match(diagnostics.join("\n"), /internally tagged find variant/);
  assert.match(diagnostics.join("\n"), /DocumentQuery.count.filter must be optional/);
  assert.match(diagnostics.join("\n"), /DocumentQuery.aggregate.allowDiskUse is an unreviewed wire field/);
  assert.match(diagnostics.join("\n"), /DocumentQuery.mapReduce is an unreviewed tagged variant/);
});
