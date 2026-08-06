import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { env } from "./env";
import * as schema from "./schema";

type NeonSql = NeonQueryFunction<false, false>;
type WorkspaceDb = ReturnType<typeof createDb>;

const globalForDb = globalThis as typeof globalThis & {
  workspaceDb?: WorkspaceDb;
  workspaceNeonSql?: NeonSql;
};

let localNeonSql: NeonSql | undefined;
let localDb: WorkspaceDb | undefined;

function getNeonSql(): NeonSql {
  const existing = globalForDb.workspaceNeonSql ?? localNeonSql;
  if (existing) return existing;

  const created = neon(env.databaseUrl());
  localNeonSql = created;
  if (process.env.NODE_ENV !== "production") {
    globalForDb.workspaceNeonSql = created;
  }
  return created;
}

function createDb() {
  return drizzle({ client: getNeonSql(), schema });
}

// Neon HTTP batches are available, but drizzle-orm's callback transaction API is
// unsupported by this driver. Atomic multi-statement flows must use the underlying
// Neon transaction/batch API or one conditional SQL statement.
function getDb(): WorkspaceDb {
  const existing = globalForDb.workspaceDb ?? localDb;
  if (existing) return existing;

  const created = createDb();
  localDb = created;
  if (process.env.NODE_ENV !== "production") {
    globalForDb.workspaceDb = created;
  }
  return created;
}

function bindIfNeeded<T>(owner: object, value: T): T {
  return typeof value === "function" ? value.bind(owner) : value;
}

const lazyNeonSqlTarget = (() => undefined) as unknown as NeonSql;

/**
 * Preserve the existing callable Neon client contract without resolving production
 * configuration while Next.js is only collecting route metadata during a build.
 */
export const neonSql = new Proxy(lazyNeonSqlTarget, {
  apply(_target, _thisArg, argumentsList) {
    const client = getNeonSql();
    return Reflect.apply(client, client, argumentsList);
  },
  get(_target, property) {
    const client = getNeonSql();
    return bindIfNeeded(client, Reflect.get(client, property, client));
  },
}) as NeonSql;

/** Resolve Drizzle on first database use, never on a route-module import. */
export const db = new Proxy({} as WorkspaceDb, {
  get(_target, property) {
    const database = getDb();
    return bindIfNeeded(database, Reflect.get(database, property, database));
  },
}) as WorkspaceDb;
