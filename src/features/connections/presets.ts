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
  source?: "standard";
};

export const CONNECTION_DEFAULT_PORTS: Record<ConnectionEngine, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
  mongodb: 27017,
};

const DEMO_SQLITE_PATH_SUFFIX = "/demos/dopedb-demo-v1.sqlite";

export function connectionDefaultSslMode(
  engine: ConnectionEngine,
): string {
  if (engine === "mysql") return "preferred";
  if (engine === "sqlite") return "disable";
  return "prefer";
}

export function blankConnection(
  preset: ConnectionLaunchPreset | null = null,
): ConnectionProfile {
  const engine = preset?.engine ?? "postgres";
  const provider = preset?.provider ?? "auto";

  return {
    id: connectionId(crypto.randomUUID()),
    name: "",
    engine,
    provider,
    driverId: null,
    host: "localhost",
    port: CONNECTION_DEFAULT_PORTS[engine],
    database: "",
    username: "",
    sslmode: connectionDefaultSslMode(engine),
    extraParams: {},
    readonlyDefault: true,
    allowWrites: false,
    secretRef: null,
    env: null,
    schemaGroup: null,
    workspaceAccess: "local",
    credentialMode: "local",
    providerTarget: null,
  };
}

export function demoSqliteConnection(path: string): ConnectionProfile {
  return {
    ...blankConnection({
      engine: "sqlite",
      provider: "generic",
    }),
    name: "Demo SQLite",
    database: path,
    driverId: "sqlx-sqlite",
    env: "dev",
  };
}

export function isDemoSqliteConnection(
  profile: ConnectionProfile,
): boolean {
  return (
    profile.engine === "sqlite" &&
    profile.database
      .replace(/\\/g, "/")
      .endsWith(DEMO_SQLITE_PATH_SUFFIX)
  );
}
