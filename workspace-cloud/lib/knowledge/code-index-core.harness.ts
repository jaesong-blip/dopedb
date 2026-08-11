import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { validateGraphBuildArtifact } from "./artifact-core";
import {
  analyzeCodeFile,
  buildCodeIndexArtifact,
  codeLanguageForPath,
} from "./code-index-core";

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
      Buffer.from("import { db } from './db'; export function users() { return db.query('select * from users') }"),
    );
    const databaseAnalysis = analyzeCodeFile(
      "src/db.ts",
      Buffer.from("export const db = { query(sql: string) { return sql } }"),
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
    expect(validateGraphBuildArtifact(artifact)).not.toBeNull();
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
  });
});
