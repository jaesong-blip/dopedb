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

// Neon HTTP supports a non-interactive multi-statement transaction.  Use it for
// commands whose second statement must observe locks acquired by the first.
export const neonSql = globalForDb.workspaceNeonSql ?? createNeonSql();
if (process.env.NODE_ENV !== "production") globalForDb.workspaceNeonSql = neonSql;
export const db = globalForDb.workspaceDb ?? createDb();
if (process.env.NODE_ENV !== "production") globalForDb.workspaceDb = db;
