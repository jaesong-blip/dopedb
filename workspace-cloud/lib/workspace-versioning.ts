// Canonical, secret-free connection version payloads and strict optimistic revision
// parsing. Route handlers persist these immutable values; this module never touches DB.
import { createHash } from "node:crypto";

import {
  parseSharedConnection,
  type SharedConnectionCredentialMode,
} from "./workspace-connections";

type ConnectionInput = ReturnType<typeof parseSharedConnection>;

export type ConnectionVersionPayload = ConnectionInput & {
  deleted: boolean;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function connectionVersionPayload(
  connection: ConnectionInput,
  deleted = false,
): ConnectionVersionPayload {
  return { ...connection, deleted };
}

export function parseConnectionVersionPayload(
  value: unknown,
  options: { credentialMode: SharedConnectionCredentialMode },
): ConnectionVersionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connection version must be an object");
  }
  const { deleted, ...connection } = value as Record<string, unknown>;
  if (typeof deleted !== "boolean") {
    throw new Error("Connection version deletion state is invalid");
  }
  return connectionVersionPayload(
    parseSharedConnection(connection, options),
    deleted,
  );
}

export function persistedConnectionVersionPayload(
  row: {
    name: string; engine: string; provider: string; driverId: string | null;
    host: string; port: number; databaseName: string; sslmode: string;
    readonlyDefault: boolean; allowWrites: boolean; environment: string | null;
    schemaGroup: string | null;
  },
  deleted = false,
): ConnectionVersionPayload {
  return {
    name: row.name,
    engine: row.engine as ConnectionInput["engine"],
    provider: row.provider as ConnectionInput["provider"],
    driverId: row.driverId,
    host: row.host,
    port: row.port,
    database: row.databaseName,
    sslmode: row.sslmode,
    readonlyDefault: row.readonlyDefault,
    allowWrites: row.allowWrites,
    env: row.environment,
    schemaGroup: row.schemaGroup,
    deleted,
  };
}

export function parseExpectedRevision(request: Request): number | null {
  const value = request.headers.get("if-match");
  if (value === null) return null;
  // Strong ETags only: neither weak validators nor HTTP's wildcard/list forms
  // can safely select an immutable workspace revision.
  const match = /^"([0-9]+)"$/.exec(value.trim());
  if (!match) throw new Error("If-Match must be a quoted non-negative revision");
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) throw new Error("Invalid expected revision");
  return revision;
}
