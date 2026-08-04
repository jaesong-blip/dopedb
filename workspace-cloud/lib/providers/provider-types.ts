// Provider-neutral contracts for redacted resource discovery and one-time database
// leases. Secret-bearing adapters narrow external responses into these shapes.

export type ManagedEngine = "postgres" | "mysql";
export type ManagedAccessMode = "read" | "write";
export type ManagedSslMode = "verify-ca" | "verify-full";
export type ProviderProductionClassification = true | false | "unknown";

export type ProviderResourceItem = {
  id: string;
  name: string;
  value: string;
  kind?: ManagedEngine;
  production?: ProviderProductionClassification;
  ready?: boolean;
  safeMigrations?: boolean;
};

export type ManagedProviderLease = {
  externalCredentialId: string;
  externalCredentialKind: "iamToken" | "password" | "role";
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslmode: ManagedSslMode;
  tlsServerCaPem?: string;
  connector?: {
    kind: "gcpCloudSqlAuthProxy";
    instanceConnectionName: string;
    accessToken: string;
    networkMode: "PUBLIC" | "PRIVATE_SERVICES_ACCESS" | "PRIVATE_SERVICE_CONNECT";
  };
  expiresAt: string;
};

export class ProviderRequestError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}
