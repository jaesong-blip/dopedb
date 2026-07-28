// Connection URL parsing is domain translation, not form presentation. Keeping
// it here lets the Tailwind editor stay focused on state and interaction while
// preserving support for SQL, SQLite, and multi-host MongoDB URLs.
import type { Engine } from "../../ipc/types";
import type { ConnectionProfile } from "./domain";
import { CONNECTION_DEFAULT_PORTS } from "./presets";

export type ParsedConnectionUrl = {
  update: Partial<ConnectionProfile>;
  password: string | null;
};

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function firstSearchParam(
  params: URLSearchParams,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = params.get(key);
    if (value != null && value !== "") return value;
  }
  return null;
}

function parseOptionalBoolean(value: string | null): boolean | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function parseUrlMetaParams(params: URLSearchParams, nameFallback: string) {
  return {
    name:
      firstSearchParam(params, [
        "name",
        "connectionName",
        "connection_name",
      ]) || nameFallback,
    env: firstSearchParam(params, ["env", "environment"]),
    readonlyDefault: parseOptionalBoolean(
      firstSearchParam(params, ["readonly", "readOnly", "read_only"]),
    ),
    allowWrites: parseOptionalBoolean(
      firstSearchParam(params, ["allowWrites", "allow_writes", "writes"]),
    ),
  };
}

function normalizeSslMode(engine: Engine, value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (["1", "true", "yes", "on"].includes(normalized)) return "require";
  if (["0", "false", "no", "off"].includes(normalized)) {
    return engine === "mysql" ? "disabled" : "disable";
  }
  if (engine === "mysql") {
    if (normalized === "disable") return "disabled";
    if (normalized === "prefer") return "preferred";
    if (normalized === "require") return "required";
    if (normalized === "verify-full") return "verify-identity";
  }
  return normalized;
}

function sqliteDatabaseFromUrl(url: URL): string {
  if (url.protocol === "file:") return decodeUrlPart(url.pathname);
  if (url.hostname && !url.pathname) return decodeUrlPart(url.hostname);
  if (url.hostname) return decodeUrlPart(`${url.hostname}${url.pathname}`);
  return decodeUrlPart(url.pathname);
}

function parseMongoConnectionUrl(text: string): ParsedConnectionUrl | null {
  const match =
    /^mongodb(\+srv)?:\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/i.exec(
      text,
    );
  if (!match) return null;
  const [, srvFlag, rawUser, rawPass, hostPart, rawDatabase, rawQuery] =
    match;
  const srv = !!srvFlag;
  const database = rawDatabase ? decodeUrlPart(rawDatabase) : "";
  const params = new URLSearchParams(rawQuery ?? "");
  const dopedbMetaKeys = new Set([
    "allow_writes",
    "allowwrites",
    "connection_name",
    "connectionname",
    "env",
    "environment",
    "name",
    "pass",
    "password",
    "read_only",
    "readonly",
    "writes",
  ]);
  const extraParams: Record<string, string> = {};
  params.forEach((value, key) => {
    if (dopedbMetaKeys.has(key.toLowerCase())) return;
    extraParams[key] = value;
  });
  if (srv) extraParams.srv = "true";

  const hosts = hostPart
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  let host: string;
  let port: number;
  if (hosts.length > 1) {
    host = hostPart;
    port = CONNECTION_DEFAULT_PORTS.mongodb;
  } else {
    const single = hosts[0] ?? "";
    const hostMatch = /^(.+?)(?::(\d+))?$/.exec(single);
    host = decodeUrlPart(hostMatch?.[1] ?? single);
    port = hostMatch?.[2]
      ? Number(hostMatch[2])
      : CONNECTION_DEFAULT_PORTS.mongodb;
  }

  const meta = parseUrlMetaParams(params, database || hosts[0] || "");
  const update: Partial<ConnectionProfile> = {
    name: meta.name,
    engine: "mongodb",
    provider: "auto",
    driverId: null,
    host,
    port,
    database,
    username: rawUser ? decodeUrlPart(rawUser) : "",
    sslmode: "prefer",
    extraParams,
  };
  if (meta.env) update.env = meta.env;
  if (meta.readonlyDefault != null) {
    update.readonlyDefault = meta.readonlyDefault;
  }
  if (meta.allowWrites != null) update.allowWrites = meta.allowWrites;

  return {
    update,
    password:
      (rawPass != null ? decodeUrlPart(rawPass) : "") ||
      firstSearchParam(params, ["password", "pass"]) ||
      null,
  };
}

export function parseConnectionUrl(raw: string): ParsedConnectionUrl | null {
  const text = raw.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!text) return null;
  if (/^mongodb(\+srv)?:\/\//i.test(text)) {
    return parseMongoConnectionUrl(text);
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  const protocol = url.protocol.replace(/:$/, "").toLowerCase();
  const engine: Engine | null =
    protocol === "postgres" || protocol === "postgresql"
      ? "postgres"
      : protocol === "mysql" || protocol === "mariadb"
        ? "mysql"
        : protocol === "sqlite" ||
            protocol === "sqlite3" ||
            protocol === "file"
          ? "sqlite"
          : null;
  if (!engine) return null;

  const extraParams: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    if (key.toLowerCase() === "password" || key.toLowerCase() === "pass") {
      return;
    }
    extraParams[key] = value;
  });

  const sslmode = normalizeSslMode(
    engine,
    firstSearchParam(url.searchParams, [
      "sslmode",
      "ssl-mode",
      "sslMode",
      "ssl",
    ]),
  );
  const database =
    engine === "sqlite"
      ? sqliteDatabaseFromUrl(url)
      : decodeUrlPart(url.pathname.replace(/^\/+/, ""));
  const meta = parseUrlMetaParams(
    url.searchParams,
    database || url.hostname || "",
  );
  const update: Partial<ConnectionProfile> = {
    name: meta.name,
    engine,
    provider: "auto",
    driverId: null,
    host: engine === "sqlite" ? "localhost" : decodeUrlPart(url.hostname),
    port: url.port
      ? Number(url.port)
      : CONNECTION_DEFAULT_PORTS[engine],
    database,
    username: decodeUrlPart(url.username),
    sslmode: sslmode ?? "prefer",
    extraParams,
  };
  if (meta.env) update.env = meta.env;
  const schemaGroup = firstSearchParam(url.searchParams, [
    "schemaGroup",
    "schema_group",
    "schema-group",
    "group",
  ]);
  if (schemaGroup) update.schemaGroup = schemaGroup;
  if (meta.readonlyDefault != null) {
    update.readonlyDefault = meta.readonlyDefault;
  }
  if (meta.allowWrites != null) update.allowWrites = meta.allowWrites;

  return {
    update,
    password:
      decodeUrlPart(url.password) ||
      firstSearchParam(url.searchParams, ["password", "pass"]) ||
      null,
  };
}
