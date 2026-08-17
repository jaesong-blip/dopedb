import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  knowledgeGraphArtifactSizeAllowed,
  MAX_KNOWLEDGE_GRAPH_ARTIFACT_BYTES,
  validateGraphBuildArtifact,
} from "./artifact-core";
import { canonicalKnowledgeJson } from "./canonical-json";
import {
  analyzeCodeFile,
  buildCodeIndexArtifact,
  buildCodeIndexArtifactFragment,
  codeIndexManifestWindow,
  codeIndexPhaseHasStartBudget,
  codeIndexQueryTimeoutMs,
  codeIndexSourceRevisionSha256,
  codeLanguageForPath,
  compareCodeIndexPath,
  mergeCodeIndexArtifacts,
} from "./code-index-core";
import {
  sourceBrowseMatches,
  sourceBrowseText,
  validSourceBrowsePath,
  validSourceBrowseRange,
  validSourceBrowseSearch,
} from "./source-browser";

describe("workspace code index", () => {
  it("extracts navigational symbols and relationships from TypeScript", () => {
    const analysis = analyzeCodeFile("src/orders.ts", Buffer.from(`
      import { db } from "./db";
      export async function loadOrders() {
        const rows = await db.query("select * from orders");
        analytics.track("orders_loaded");
        return rows;
      }
      export const secretHandler = () => send("do-not-share-body");
    `));
    expect(analysis?.symbols.some((symbol) => symbol.name === "loadOrders")).toBe(true);
    expect(analysis?.references.some((reference) =>
      reference.relation === "imports" && reference.targetName === "./db"
    )).toBe(true);
    expect(analysis?.references.some((reference) =>
      reference.relation === "reads_table" && reference.targetName === "orders"
    )).toBe(true);
    expect(analysis?.references.some((reference) =>
      reference.relation === "emits_event" && reference.targetName === "orders_loaded"
    )).toBe(true);
    expect(analysis?.symbols.find((symbol) => symbol.name === "secretHandler")?.signature)
      .not.toContain("do-not-share-body");
  });

  it("keeps unsupported content out of the parser", () => {
    expect(codeLanguageForPath("assets/logo.png")).toBeNull();
    expect(analyzeCodeFile("src/main.rs", Buffer.from("pub fn main() {}"))?.symbols[0]?.name)
      .toBe("main");
    expect(analyzeCodeFile("src/binary.ts", Buffer.from([0, 1, 2]))).toBeNull();
    expect(analyzeCodeFile("src/unsafe\npath.ts", Buffer.from("export const value = 1")))
      .toBeNull();
    expect(analyzeCodeFile("src/unsafe\u0085path.ts", Buffer.from("export const value = 1")))
      .toBeNull();
    const browse = sourceBrowseMatches([
      { path: "src/main.ts", blobSha: "a".repeat(40), bytes: 42 },
      { path: "src/users/service.ts", blobSha: "b".repeat(40), bytes: 84 },
    ], "users service", 20);
    expect(browse).toEqual({
      matches: [{ path: "src/users/service.ts", blobSha: "b".repeat(40), bytes: 84 }],
      totalMatches: 1,
      truncated: false,
    });
    expect(sourceBrowseText(Buffer.from("one\ntwo\nthree"), 2, 3)).toMatchObject({
      lineStart: 2,
      lineEnd: 3,
      totalLines: 3,
      truncated: false,
      text: "two\nthree",
    });
    expect(() => sourceBrowseText(Buffer.from([0xff]), 1, 1)).toThrow();
    expect(validSourceBrowseSearch("orders service", 20)).toBe(true);
    expect(validSourceBrowseSearch("\u0085", 20)).toBe(false);
    expect(validSourceBrowsePath("src/orders.ts")).toBe(true);
    expect(validSourceBrowsePath("../secrets.env")).toBe(false);
    expect(validSourceBrowseRange(1, 400)).toBe(true);
    expect(validSourceBrowseRange(1, 401)).toBe(false);
  });

  it("extracts navigation from common non-TypeScript services", () => {
    const analysis = analyzeCodeFile("cmd/api/main.go", Buffer.from(`
      package main
      import "database/sql"
      type Server struct {}
      func (server *Server) LoadUsers() {
        rows := queryUsers()
        router.GET("/users", rows)
      }
    `));
    expect(analysis?.symbols.some((symbol) =>
      symbol.kind === "type" && symbol.name === "Server"
    )).toBe(true);
    expect(analysis?.symbols.some((symbol) =>
      symbol.kind === "function" && symbol.name === "LoadUsers"
    )).toBe(true);
    expect(analysis?.references.some((reference) =>
      reference.relation === "calls" && reference.targetName === "queryUsers"
    )).toBe(true);
    expect(analysis?.references.some((reference) =>
      reference.relation === "handles_route" && reference.targetName === "GET /users"
    )).toBe(true);
    const nextRoute = analyzeCodeFile(
      "src/app/api/users/[userId]/route.ts",
      Buffer.from("export async function GET() { return Response.json({ ok: true }) }"),
    );
    expect(nextRoute?.references.some((reference) =>
      reference.relation === "handles_route"
      && reference.targetName === "GET /api/users/:userId"
    )).toBe(true);
  });

  it("builds one exact grant-compatible artifact from normalized fragments", () => {
    const sourceId = randomUUID();
    const analysis = analyzeCodeFile(
      "src/main.ts",
      Buffer.from("import { db, run } from './db'; export function users() { run(); return db.query('select * from users') }"),
    );
    const databaseAnalysis = analyzeCodeFile(
      "src/db.ts",
      Buffer.from("export function run() {} export const db = { query(sql: string) { return sql } }"),
    );
    const artifact = buildCodeIndexArtifact({
      sourceId,
      projectId: randomUUID(),
      projectEnvironmentId: randomUUID(),
      environmentRevision: 1,
      displayName: "acme/app",
      repositoryId: "1001",
      repository: "acme/app",
      refName: "main",
      commitSha: "a".repeat(40),
      parentGraphRevisionId: null,
      changedFiles: ["src/main.ts"],
      generatedAt: "2026-08-11T00:00:00Z",
      files: [{
        path: "src/main.ts",
        blobSha: "b".repeat(40),
        bytes: 100,
        language: "typescript",
        analysis,
      }, {
        path: "src/db.ts",
        blobSha: "c".repeat(40),
        bytes: 60,
        language: "typescript",
        analysis: databaseAnalysis,
      }],
    });
    const validatedArtifact = validateGraphBuildArtifact(artifact);
    expect(validatedArtifact).not.toBeNull();
    expect(validateGraphBuildArtifact({ ...artifact, generatedAt: "2026-08-11" })).toBeNull();
    expect(validateGraphBuildArtifact({ ...artifact, generatedAt: "2026-02-30T00:00:00Z" }))
      .toBeNull();
    expect(validateGraphBuildArtifact({
      ...artifact,
      extractor: { ...artifact.extractor as object, version: "1.0.0-beta" },
    })).toBeNull();
    expect(validateGraphBuildArtifact({
      ...artifact,
      changedFiles: Array.from({ length: 100_001 }, (_, index) => `src/${index}.ts`),
    })).toBeNull();
    expect(validateGraphBuildArtifact(Object.fromEntries(Object.entries(artifact).reverse()))
      ?.artifactSha256).toBe(validatedArtifact?.artifactSha256);
    expect(knowledgeGraphArtifactSizeAllowed(MAX_KNOWLEDGE_GRAPH_ARTIFACT_BYTES)).toBe(true);
    expect(knowledgeGraphArtifactSizeAllowed(MAX_KNOWLEDGE_GRAPH_ARTIFACT_BYTES + 1)).toBe(false);
    expect(codeIndexManifestWindow(2_500, 0, 1_000)).toEqual({
      start: 0,
      end: 1_000,
      complete: false,
    });
    expect(codeIndexManifestWindow(2_500, 1_000, 1_000)).toEqual({
      start: 1_000,
      end: 2_000,
      complete: false,
    });
    expect(codeIndexManifestWindow(2_500, 2_500, 1_000)).toEqual({
      start: 2_500,
      end: 2_500,
      complete: true,
    });
    expect(codeIndexPhaseHasStartBudget("manifest", 40_000)).toBe(true);
    expect(codeIndexPhaseHasStartBudget("indexing", 40_000)).toBe(true);
    expect(codeIndexPhaseHasStartBudget("activating", 40_000)).toBe(true);
    expect(codeIndexPhaseHasStartBudget("activating", 29_999)).toBe(false);
    expect(codeIndexQueryTimeoutMs(40_000)).toBe(20_000);
    expect(codeIndexQueryTimeoutMs(24_000)).toBe(19_000);
    expect(codeIndexQueryTimeoutMs(5_999)).toBeNull();
    const mixedPaths = ["src/a.ts", "src/가.ts", "src/Z.ts", "src/é.ts"];
    const byteOrderedPaths = [...mixedPaths].sort(compareCodeIndexPath);
    expect(byteOrderedPaths).toEqual(["src/Z.ts", "src/a.ts", "src/é.ts", "src/가.ts"]);
    expect(codeIndexSourceRevisionSha256(byteOrderedPaths.map((path, index) => ({
      path,
      blobSha: String(index + 1).repeat(40),
      bytes: index,
    })))).toBe(codeIndexSourceRevisionSha256([...byteOrderedPaths].reverse().map((path) => ({
      path,
      blobSha: String(byteOrderedPaths.indexOf(path) + 1).repeat(40),
      bytes: byteOrderedPaths.indexOf(path),
    }))));
    const canonicalVector = canonicalKnowledgeJson({
      z: [{ "β": 2, a: 1 }, "한글"],
      a: { "😀": true, "": null, 2: "two", 10: "ten" },
    });
    expect(canonicalVector).toBe(
      '{"a":{"10":"ten","2":"two","":null,"😀":true},"z":[{"a":1,"β":2},"한글"]}',
    );
    expect(createHash("sha256").update(canonicalVector).digest("hex"))
      .toBe("d6168ccb84693cd24b6b4d6c462dac4ab5b258b5566a684a0bbfd186fcfeebbd");
    const goldenArtifact = JSON.parse(readFileSync(
      new URL("../../../dopedb-protocol/tests/fixtures/graph-build-artifact-v1.json", import.meta.url),
      "utf8",
    ));
    expect(createHash("sha256").update(canonicalKnowledgeJson(goldenArtifact)).digest("hex"))
      .toBe("cd6d4a78ca01576d8d2716ac1f168c1de3c75bbb7f73ded342edd93af28a55f0");
    expect((artifact.extractor as Record<string, unknown>).id).toBe("dopedb.code-index");
    expect((artifact.nodes as Array<Record<string, unknown>>).some((node) =>
      (node.attributes as Record<string, string> | undefined)?.signature?.includes("users")
    )).toBe(true);
    const nodes = artifact.nodes as Array<Record<string, unknown>>;
    const main = nodes.find((node) => node.qualifiedName === "src/main.ts");
    const database = nodes.find((node) => node.qualifiedName === "src/db.ts");
    expect((artifact.edges as Array<Record<string, unknown>>).some((edge) =>
      edge.relation === "imports" && edge.from === main?.id && edge.to === database?.id
    )).toBe(true);

    const fragmentInput = {
      sourceId,
      projectId: (artifact.binding as Record<string, unknown>).projectId as string,
      projectEnvironmentId:
        (artifact.binding as Record<string, unknown>).projectEnvironmentId as string,
      environmentRevision: 1,
      displayName: "acme/app",
      repositoryId: "1001",
      repository: "acme/app",
      refName: "main",
      commitSha: "a".repeat(40),
      parentGraphRevisionId: null,
      changedFiles: ["src/main.ts"],
      generatedAt: "2026-08-11T00:00:00Z",
      completeFileManifest: [{
        path: "src/db.ts",
        blobSha: "c".repeat(40),
        bytes: 60,
      }, {
        path: "src/main.ts",
        blobSha: "b".repeat(40),
        bytes: 100,
      }],
    };
    const fragments = [
      buildCodeIndexArtifactFragment({
        ...fragmentInput,
        files: [{
          path: "src/main.ts",
          blobSha: "b".repeat(40),
          bytes: 100,
          language: "typescript",
          analysis,
        }],
      }),
      buildCodeIndexArtifactFragment({
        ...fragmentInput,
        files: [{
          path: "src/db.ts",
          blobSha: "c".repeat(40),
          bytes: 60,
          language: "typescript",
          analysis: databaseAnalysis,
        }],
      }),
    ];
    expect(new Set(fragments.map((fragment) => fragment.sourceRevisionSha256)).size).toBe(1);
    expect(new Set(fragments.map((fragment) => fragment.graphRevisionId)).size).toBe(1);
    const merged = mergeCodeIndexArtifacts({ ...fragmentInput, fragments });
    expect(merged.sourceRevisionSha256).toBe(artifact.sourceRevisionSha256);
    expect(merged.graphRevisionId).toBe(artifact.graphRevisionId);
    expect((merged.nodes as Array<Record<string, unknown>>).filter((node) =>
      node.kind === "file"
    )).toHaveLength(2);
    expect(canonicalKnowledgeJson(merged)).toBe(canonicalKnowledgeJson(artifact));
  });
});
