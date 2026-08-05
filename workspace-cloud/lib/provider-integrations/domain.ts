import {
  allowDiscoveryImport,
  providerImportProjection,
} from "../providers/import-projection";
import type { PlanetScaleResource } from "../providers/planetscale";
import {
  parseNeonResource,
  type NeonResource,
} from "../providers/neon-core";
import {
  parseGcpCloudSqlResource,
  type GcpCloudSqlResource,
} from "../providers/gcp-cloud-sql-core";
import type { ProviderResourceItem } from "../providers/provider-types";

export type ManagedProviderResource =
  | PlanetScaleResource
  | NeonResource
  | GcpCloudSqlResource;

export type LeaseRevocationFilter = {
  organizationId: string;
  leaseId?: string;
  userId?: string;
  connectionId?: string;
  integrationId?: string;
};

export type LeaseRevocationResult = {
  revoked: number;
  deferred: number;
};

export type ExpiredLeaseCleanupResult = LeaseRevocationResult & {
  scanned: number;
};

export const CLEANUP_CLAIM_STALE_SECONDS = 2 * 60;
const CLEANUP_RETRY_BASE_MS = 60 * 1_000;
const CLEANUP_RETRY_MAX_MS = 60 * 60 * 1_000;

export function managedLeaseCleanupRetryDelayMs(attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Invalid managed lease cleanup attempt");
  }
  return Math.min(
    CLEANUP_RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 16)),
    CLEANUP_RETRY_MAX_MS,
  );
}

export function isSegment(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function parsePlanetScaleResource(value: unknown): PlanetScaleResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PlanetScale resource is required");
  }
  const body = value as Record<string, unknown>;
  if (
    !isSegment(body.organization)
    || !isSegment(body.database)
    || !isSegment(body.branch)
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

export function parseManagedProviderResource(
  provider: string,
  value: unknown,
): ManagedProviderResource {
  switch (provider) {
    case "planetScale":
      return parsePlanetScaleResource(value);
    case "neon":
      return parseNeonResource(value);
    case "gcpCloudSql":
      return parseGcpCloudSqlResource(value);
    default:
      throw new Error("Managed credential provider is not available");
  }
}

// Only a final adapter-discovered item can become an import receipt.  In
// particular, callers cannot turn a known external id into a resource object.
export function discoveredProviderResource(input: {
  provider: string;
  kind: string;
  selection: Record<string, string>;
  item: ProviderResourceItem;
  writeAvailable?: boolean;
}) {
  if (!allowDiscoveryImport(input.provider, input.item)) return null;
  const engine = input.item.kind ?? input.selection.engine;
  let resource: ManagedProviderResource;
  if (input.provider === "planetScale" && input.kind === "branches") {
    resource = parsePlanetScaleResource({
      organization: input.selection.organization,
      database: input.selection.database,
      branch: input.item.value,
      engine,
    });
  } else if (input.provider === "neon" && input.kind === "databases") {
    resource = parseNeonResource({
      project: input.selection.project,
      branch: input.selection.branch,
      databaseId: input.item.id,
      database: input.item.value,
      engine: "postgres",
    });
  } else if (input.provider === "gcpCloudSql" && input.kind === "databases") {
    resource = parseGcpCloudSqlResource({
      project: input.selection.project,
      instance: input.selection.instance,
      database: input.item.value,
      engine,
      // DopeDB Desktop runs on the member's machine, which is not ordinarily
      // routed into the instance VPC. The official Auth Proxy uses the public
      // endpoint securely by default; private IP remains an explicit adapter
      // capability for a future, verified VPC-attached execution path.
      networkMode: "PUBLIC",
      production: input.item.production,
    });
  } else {
    return null;
  }
  return providerImportProjection(
    input.provider as "planetScale" | "neon" | "gcpCloudSql",
    resource,
    {
      writeAvailable: input.writeAvailable === true,
      ...(input.provider === "neon" && input.item.providerTarget
        ? { neonBranchTarget: input.item.providerTarget }
        : {}),
      ...(input.provider === "planetScale" ? {
        production: input.item.production as boolean,
        ...(engine === "mysql"
          ? { safeMigrations: input.item.safeMigrations }
          : {}),
      } : {}),
    },
  );
}
