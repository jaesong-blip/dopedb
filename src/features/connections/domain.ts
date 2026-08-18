/**
 * Connection wire/domain values.
 *
 * The brand prevents workspace, document, and connection IDs from being exchanged
 * accidentally while preserving the UUID string sent over Tauri.
 */

declare const connectionIdBrand: unique symbol;

export type ConnectionId = string & {
  readonly [connectionIdBrand]: "ConnectionId";
};

export function connectionId(value: string): ConnectionId {
  return value as ConnectionId;
}

export type ConnectionEngine = "postgres" | "mysql" | "sqlite" | "mongodb";
export type ConnectionProvider =
  | "auto"
  | "generic"
  | "neon"
  | "planetScale"
  | "gcpCloudSql";
export type WorkspaceConnectionAccess =
  | "view"
  | "read"
  | "write"
  | "manage"
  | "local";
export type WorkspaceCredentialMode = "local" | "memberLocal" | "managed";

export type NeonBranchState =
  | "init"
  | "resetting"
  | "ready"
  | "archived"
  | "unknown";

export type ConnectionProviderTarget = {
  provider: "neon";
  projectId: string;
  branchId: string;
  branchName: string | null;
  currentState: NeonBranchState | null;
  pendingState: NeonBranchState | null;
  default: boolean | null;
  protected: boolean | null;
};

export interface ConnectionProfile {
  id: ConnectionId;
  name: string;
  engine: ConnectionEngine;
  provider: ConnectionProvider;
  driverId: string | null;
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: string;
  extraParams: Record<string, string>;
  readonlyDefault: boolean;
  allowWrites: boolean;
  secretRef: string | null;
  env: string | null;
  schemaGroup: string | null;
  workspaceAccess: WorkspaceConnectionAccess;
  credentialMode: WorkspaceCredentialMode;
  providerTarget: ConnectionProviderTarget | null;
}

export type ConnectionTestFailureCode =
  | "timeoutNetwork"
  | "authentication"
  | "tls"
  | "databaseConfig"
  | "unknown";

export type ConnectionTestFailureField =
  | "credentials"
  | "tls"
  | "database";

export interface ConnectionTestFailure {
  code: ConnectionTestFailureCode;
  field: ConnectionTestFailureField | null;
  detail: string;
}

export type ConnectionTestReceipt =
  | { ok: true; failure: null }
  | { ok: false; failure: ConnectionTestFailure };

export type ConnectionAccessIssue = "grant" | "credentials";

/** One authority-neutral projection shared by Explorer loading and recovery UI. */
export function connectionAccessIssue(
  connection: Pick<
    ConnectionProfile,
    "credentialMode" | "secretRef" | "workspaceAccess"
  >,
): ConnectionAccessIssue | undefined {
  if (connection.workspaceAccess === "view") return "grant";
  if (
    connection.workspaceAccess !== "local"
    && connection.credentialMode === "memberLocal"
    && connection.secretRef === null
  ) {
    return "credentials";
  }
  return undefined;
}

type DriverInstallMode = "bundled" | "managed";
type DriverInstallState = "installed" | "available" | "planned";

export type DriverCapability =
  | "sql"
  | "documentQuery"
  | "transactions"
  | "introspection"
  | "collections"
  | "schemaDiff"
  | "monitoring";

export interface DriverDescriptor {
  id: string;
  name: string;
  engine: ConnectionEngine;
  version: string;
  installMode: DriverInstallMode;
  installState: DriverInstallState;
  supportedProviders: ConnectionProvider[];
  capabilities: DriverCapability[];
  recommended: boolean;
}
