// Provider-specific resource reconstruction. Each adapter accepts only its exact
// scalar shape, then produces the shared redacted projection contract. Imports
// still start read-only; the capability only records whether an administrator may
// later enable the separately gated managed write path.
import {
  providerProjection,
  type ProviderCapabilityManifest,
  type ProviderImportAdapter,
  type ProviderImportProjection,
} from "./adapter-contract";
import { parseGcpCloudSqlResource, type GcpCloudSqlResource } from "./gcp-cloud-sql-core";
import { parseNeonResource, type NeonResource } from "./neon-core";
import type { PlanetScaleResource } from "./planetscale";

export type DiscoverableProviderResource = PlanetScaleResource | NeonResource | GcpCloudSqlResource;
export type ImportProvider = "neon" | "gcpCloudSql" | "planetScale";

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider resource is required");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key))) {
    throw new Error("Provider resource contains unsupported fields");
  }
  return record;
}

function segment(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function parsePlanetScaleImportResource(value: unknown): PlanetScaleResource {
  const body = exactRecord(value, ["organization", "database", "branch", "engine"]);
  if (
    !segment(body.organization)
    || !segment(body.database)
    || !segment(body.branch)
    || (body.engine !== "postgres" && body.engine !== "mysql")
  ) {
    throw new Error("Invalid PlanetScale resource");
  }
  return {
    organization: body.organization,
    database: body.database,
    branch: body.branch,
    engine: body.engine,
  };
}

function parseNeonImportResource(value: unknown): NeonResource {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const body = exactRecord(
    value,
    record && Object.hasOwn(record, "databaseId")
      ? ["project", "branch", "databaseId", "database", "engine", "schemas"]
      : ["project", "branch", "database", "engine", "schemas"],
  );
  const normalized = parseNeonResource(body);
  return {
    project: normalized.project,
    branch: normalized.branch,
    databaseId: normalized.databaseId,
    database: normalized.database,
    engine: "postgres",
    schemas: [...normalized.schemas],
  };
}

function parseGcpImportResource(value: unknown): GcpCloudSqlResource {
  const body = exactRecord(
    value,
    ["project", "instance", "database", "engine", "networkMode", "production"],
  );
  const normalized = parseGcpCloudSqlResource(body);
  return {
    project: normalized.project,
    instance: normalized.instance,
    database: normalized.database,
    engine: normalized.engine,
    networkMode: normalized.networkMode,
    production: normalized.production,
  };
}

function capabilities(managedLease: boolean): ProviderCapabilityManifest {
  return { discover: true, importReadOnly: true, managedLease, write: false };
}

function projection(
  provider: ImportProvider,
  resource: DiscoverableProviderResource,
  metadata: Record<string, string | number | boolean | null>,
  database: string,
  engine: "postgres" | "mysql",
  capabilityManifest: ProviderCapabilityManifest,
) {
  return providerProjection({
    provider,
    resource: { ...resource },
    metadata,
    capabilities: capabilityManifest,
    host: `${provider.toLowerCase()}.managed.invalid`,
    port: engine === "postgres" ? 5432 : 3306,
    database,
    engine,
    sslmode: "verify-full",
  });
}

export const providerImportAdapters: Record<
  ImportProvider,
  ProviderImportAdapter<DiscoverableProviderResource>
> = {
  neon: {
    provider: "neon",
    reconstruct: parseNeonImportResource,
    capabilities: () => capabilities(true), // issueNeonLease is the concrete lease adapter.
    importProjection(resource) {
      const value = resource as NeonResource;
      return projection("neon", value, {
        project: value.project, branch: value.branch, database: value.database, engine: value.engine,
        // This is a server-derived final-leaf fact, never browser input. The
        // local-target authority repeats it as a durable fail-closed predicate.
        production: false,
      }, value.database, value.engine, this.capabilities(value));
    },
  },
  gcpCloudSql: {
    provider: "gcpCloudSql",
    reconstruct: parseGcpImportResource,
    capabilities: () => capabilities(true), // issueGcpCloudSqlLease is the concrete lease adapter.
    importProjection(resource) {
      const value = resource as GcpCloudSqlResource;
      return projection("gcpCloudSql", value, {
        project: value.project, instance: value.instance, database: value.database,
        engine: value.engine, networkMode: value.networkMode, production: value.production,
      }, value.database, value.engine, this.capabilities(value));
    },
  },
  planetScale: {
    provider: "planetScale",
    reconstruct: parsePlanetScaleImportResource,
    capabilities: () => capabilities(true), // issuePlanetScaleLease is the concrete lease adapter.
    importProjection(resource) {
      const value = resource as PlanetScaleResource;
      return projection("planetScale", value, {
        organization: value.organization, database: value.database, branch: value.branch, engine: value.engine,
        production: false,
      }, value.database, value.engine, this.capabilities(value));
    },
  },
};

export function providerImportProjection(
  provider: ImportProvider,
  value: unknown,
  options: {
    writeAvailable?: boolean;
    production?: boolean;
    safeMigrations?: boolean;
  } = {},
): ProviderImportProjection {
  const adapter = providerImportAdapters[provider];
  const resource = adapter.reconstruct(value);
  let projected = adapter.importProjection(resource);
  if (provider === "planetScale") {
    const planetScale = resource as PlanetScaleResource;
    if (
      typeof options.production !== "boolean"
      || (planetScale.engine === "mysql" && typeof options.safeMigrations !== "boolean")
      || (planetScale.engine === "postgres" && options.safeMigrations !== undefined)
    ) {
      throw new Error("PlanetScale branch policy is incomplete");
    }
    projected = {
      ...projected,
      metadata: {
        ...projected.metadata,
        production: options.production,
        safeMigrations: planetScale.engine === "mysql"
          ? options.safeMigrations!
          : null,
      },
    };
  } else if (provider === "neon") {
    if (typeof options.production !== "boolean") {
      throw new Error("Neon bootstrap classification is incomplete");
    }
    projected = {
      ...projected,
      metadata: {
        ...projected.metadata,
        production: options.production,
      },
    };
  }
  if (!options.writeAvailable) return projected;
  if (
    provider !== "gcpCloudSql"
    && provider !== "planetScale"
  ) {
    throw new Error("Managed write capability is not available for this provider");
  }
  return {
    ...projected,
    capabilities: { ...projected.capabilities, write: true },
  };
}

export function allowDiscoveryImport(
  provider: string,
  item: {
    ready?: boolean;
    production?: true | false | "unknown";
    kind?: "postgres" | "mysql";
    safeMigrations?: boolean;
  },
) {
  // Provider-wide token scopes never override DopeDB's narrow import policy.
  return item.ready === true
    && (
      (provider !== "neon" && item.production === false)
      || (provider === "gcpCloudSql" && item.production === true)
      || (
        provider === "planetScale"
        && item.production === true
        && (
          item.kind === "postgres"
          || (item.kind === "mysql" && item.safeMigrations === true)
        )
      )
    );
}
