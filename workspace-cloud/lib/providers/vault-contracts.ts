import { ProviderRequestError } from "./provider-types";

export const VAULT_MAX_DATABASE_LEASE_SECONDS = 15 * 60;

export type VaultCredential = Readonly<{
  kind: "appRole";
  schemaVersion: 1;
  address: string;
  namespace: string | null;
  authMount: string;
  roleId: string;
  secretId: string;
  databaseMount: string;
  databaseConnection: string;
  readRole: string;
  writeRole: string | null;
  target: Readonly<{
    host: string;
    port: number;
    database: string;
    engine: "postgres" | "mysql";
    sslmode: "verify-full";
    production: boolean;
  }>;
}>;

export type VaultManagedResource = Readonly<{
  targetFingerprint: string;
  databaseMount: string;
  databaseConnection: string;
  readRole: string;
  writeRole: string | null;
  host: string;
  port: number;
  database: string;
  engine: "postgres" | "mysql";
  sslmode: "verify-full";
}>;

export type VaultSession = Readonly<{
  token: string;
  providerAuditId: string;
  expiresAtMs: number;
}>;

export class VaultLeaseCleanupRequiredError extends ProviderRequestError {
  constructor(
    public readonly externalCredentialId: string,
    public readonly providerAuditId: string,
  ) {
    super(
      "vault",
      "Vault database credential cleanup must complete before access can continue",
      503,
    );
    this.name = "VaultLeaseCleanupRequiredError";
  }
}
