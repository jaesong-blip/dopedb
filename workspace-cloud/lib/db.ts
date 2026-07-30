import "server-only";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { env } from "./env";
import * as schema from "./schema";

const globalForDb = globalThis as typeof globalThis & {
  workspaceDb?: ReturnType<typeof createDb>;
  workspaceNeonSql?: ReturnType<typeof createNeonSql>;
};

function createNeonSql() {
  return neon(env.databaseUrl());
}

function createDb() {
  return drizzle({ client: neonSql, schema });
}

// Neon HTTP batches are available, but drizzle-orm's callback transaction API is
// unsupported by this driver. Atomic multi-statement flows must use the underlying
// Neon transaction/batch API or one conditional SQL statement.
export const neonSql = globalForDb.workspaceNeonSql ?? createNeonSql();
if (process.env.NODE_ENV !== "production") globalForDb.workspaceNeonSql = neonSql;
export const db = globalForDb.workspaceDb ?? createDb();
if (process.env.NODE_ENV !== "production") globalForDb.workspaceDb = db;
