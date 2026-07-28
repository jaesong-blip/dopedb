// Data-source launch presets shared by the empty Database Explorer, top-level
// IDE commands, and the connection editor. Presets only describe local form
// defaults; credentials and provider authority still flow through the existing
// connection use cases.
import {
  connectionId,
  type ConnectionEngine,
  type ConnectionProfile,
  type ConnectionProvider,
} from "./domain";

export type ConnectionLaunchPreset = {
  engine?: ConnectionEngine;
  provider?: ConnectionProvider;
  source?: "standard" | "cloud" | "demo";
};

export const CONNECTION_DEFAULT_PORTS: Record<ConnectionEngine, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
  mongodb: 27017,
};

export function blankConnection(
  preset: ConnectionLaunchPreset | null = null,
): ConnectionProfile {
  const engine = preset?.engine ?? "postgres";
  const provider = preset?.provider ?? "auto";
  const demo = preset?.source === "demo";
  const engineLabel =
    engine === "postgres"
      ? "PostgreSQL"
      : engine === "mysql"
        ? "MySQL"
        : engine === "sqlite"
          ? "SQLite"
          : "MongoDB";

  return {
    id: connectionId(crypto.randomUUID()),
    name: demo ? `Demo ${engineLabel}` : "",
    engine,
    provider,
    driverId: null,
    host: "localhost",
    port: CONNECTION_DEFAULT_PORTS[engine],
    database: demo && engine !== "sqlite" ? "dopedb_demo" : "",
    username: "",
    sslmode: "prefer",
    extraParams: {},
    readonlyDefault: true,
    allowWrites: false,
    secretRef: null,
    env: demo ? "dev" : null,
    schemaGroup: null,
    workspaceAccess: "local",
    credentialMode: "local",
  };
}

export function demoSqliteConnection(path: string): ConnectionProfile {
  return {
    ...blankConnection({
      engine: "sqlite",
      provider: "generic",
      source: "demo",
    }),
    database: path,
    driverId: "sqlx-sqlite",
  };
}
