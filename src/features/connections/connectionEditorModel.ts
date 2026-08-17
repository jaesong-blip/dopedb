// Pure Connection editor types and engine rules shared by the profile,
// catalog, and schema controllers.
import type { Engine, Provider } from "../../ipc/types";
import { isDocumentEngine } from "../../lib/capabilities";
import {
  OBJECT_PATTERN_PARAMETER,
  SCHEMA_SCOPE_PARAMETER,
} from "../catalogExplorer/scopeFilter";
import {
  CONNECTION_AUTO_DISCONNECT_SECONDS_PARAMETER,
  CONNECTION_INPUT_MODE_PARAMETER,
  CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER,
  CONNECTION_SSH_ALIAS_PARAMETER,
  CONNECTION_STARTUP_SCRIPT_PARAMETER,
  CONNECTION_TIME_ZONE_PARAMETER,
} from "./options";
import { connectionDefaultSslMode } from "./presets";
import type { ConnectionProfile, DriverDescriptor } from "./domain";

export type ConnectionEditorView = "dataSources" | "clouds" | "drivers";
export type ConnectionInputMode = "default" | "urlOnly";
export type ConnectionTab =
  | "general"
  | "options"
  | "sshSsl"
  | "schemas"
  | "advanced";

export type StandardConnectionSource = {
  engine: Engine;
  provider: Provider;
  label: string;
  category: "database" | "file";
};

export const POSTGRES_SSL_MODES = [
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
] as const;

export const MYSQL_SSL_MODES = [
  "disabled",
  "preferred",
  "required",
  "verify-ca",
  "verify-identity",
] as const;

export const SQL_TLS_PARAMETERS = [
  "sslrootcert",
  "sslrootcert_pem",
  "sslcert",
  "sslcert_pem",
  "sslkey",
  "sslkey_pem",
] as const;

export const MONGO_TLS_PARAMETERS = [
  "tls",
  "tlsCAFile",
  "tlsCertificateKeyFile",
] as const;

export const CONTROLLED_CONNECTION_PARAMETERS = new Set<string>([
  ...SQL_TLS_PARAMETERS,
  ...MONGO_TLS_PARAMETERS,
  CONNECTION_SSH_ALIAS_PARAMETER,
  CONNECTION_INPUT_MODE_PARAMETER,
  CONNECTION_TIME_ZONE_PARAMETER,
  CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER,
  CONNECTION_AUTO_DISCONNECT_SECONDS_PARAMETER,
  CONNECTION_STARTUP_SCRIPT_PARAMETER,
  "srv",
]);

export const STANDARD_CONNECTION_SOURCES: StandardConnectionSource[] = [
  {
    engine: "postgres",
    provider: "auto",
    label: "PostgreSQL",
    category: "database",
  },
  {
    engine: "mysql",
    provider: "auto",
    label: "MySQL / MariaDB",
    category: "database",
  },
  {
    engine: "mongodb",
    provider: "generic",
    label: "MongoDB",
    category: "database",
  },
  {
    engine: "sqlite",
    provider: "generic",
    label: "SQLite",
    category: "file",
  },
];

export function compatibleDrivers(
  drivers: DriverDescriptor[],
  engine: Engine,
  provider: Provider,
): DriverDescriptor[] {
  return drivers.filter(
    (driver) =>
      driver.installState !== "planned" &&
      driver.engine === engine &&
      (provider === "auto" || driver.supportedProviders.includes(provider)),
  );
}

export function sslModeForEngine(engine: Engine, current: string): string {
  const normalized = current.trim().toLowerCase().replace(/_/g, "-");
  if (engine === "postgres") {
    const mapped =
      normalized === "disabled"
        ? "disable"
        : normalized === "preferred"
          ? "prefer"
          : normalized === "required"
            ? "require"
            : normalized === "verify-identity"
              ? "verify-full"
              : normalized;
    return POSTGRES_SSL_MODES.includes(
      mapped as (typeof POSTGRES_SSL_MODES)[number],
    )
      ? mapped
      : connectionDefaultSslMode(engine);
  }
  if (engine === "mysql") {
    const mapped =
      normalized === "disable"
        ? "disabled"
        : normalized === "prefer"
          ? "preferred"
          : normalized === "require"
            ? "required"
            : normalized === "verify-full"
              ? "verify-identity"
              : normalized;
    return MYSQL_SSL_MODES.includes(
      mapped as (typeof MYSQL_SSL_MODES)[number],
    )
      ? mapped
      : connectionDefaultSslMode(engine);
  }
  return connectionDefaultSslMode(engine);
}

export function connectionProfileFlags(form: ConnectionProfile) {
  const isSqlite = form.engine === "sqlite";
  const isMongo = form.engine === "mongodb";
  const isSharedTemplate = form.workspaceAccess !== "local";
  const supportsSqlSessionOptions =
    form.engine === "postgres" || form.engine === "mysql";
  const canDiscoverDatabases =
    !isSqlite &&
    !isSharedTemplate &&
    (form.engine === "postgres" ||
      form.engine === "mysql" ||
      form.engine === "mongodb");
  return {
    isSqlite,
    isMongo,
    isSharedTemplate,
    canEditConnection:
      !isSharedTemplate || form.workspaceAccess === "manage",
    supportsSqlSessionOptions,
    canDiscoverDatabases,
    supportsStartupScript: supportsSqlSessionOptions,
    keepAliveEnabled:
      CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER in form.extraParams,
    autoDisconnectEnabled:
      CONNECTION_AUTO_DISCONNECT_SECONDS_PARAMETER in form.extraParams,
    srv: form.extraParams.srv === "true",
    mongoTlsEnabled: form.extraParams.tls?.toLowerCase() === "true",
    sqlSslModes:
      form.engine === "mysql" ? MYSQL_SSL_MODES : POSTGRES_SSL_MODES,
    sqlTlsEnabled: !["disable", "disabled"].includes(form.sslmode),
  };
}

export function clearIncompatibleSourceParameters(
  current: ConnectionProfile,
  engine: Engine,
) {
  const extraParams = { ...current.extraParams };
  if (isDocumentEngine(engine)) {
    delete extraParams[SCHEMA_SCOPE_PARAMETER];
    delete extraParams[OBJECT_PATTERN_PARAMETER];
    delete extraParams[CONNECTION_TIME_ZONE_PARAMETER];
    delete extraParams[CONNECTION_STARTUP_SCRIPT_PARAMETER];
    delete extraParams[CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER];
  }
  if (engine === "sqlite") {
    delete extraParams[CONNECTION_TIME_ZONE_PARAMETER];
    delete extraParams[CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER];
    delete extraParams[CONNECTION_STARTUP_SCRIPT_PARAMETER];
    delete extraParams[CONNECTION_SSH_ALIAS_PARAMETER];
  }
  if (engine === "mongodb" || engine === "sqlite") {
    for (const key of SQL_TLS_PARAMETERS) delete extraParams[key];
  }
  if (engine !== "mongodb") {
    for (const key of MONGO_TLS_PARAMETERS) delete extraParams[key];
  }
  return extraParams;
}
