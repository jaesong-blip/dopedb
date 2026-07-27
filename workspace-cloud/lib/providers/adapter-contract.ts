// Provider-neutral import boundary. Concrete adapters reconstruct their own
// allowlisted resource before this module fingerprints and persists it; provider
// API responses and credentials never cross this boundary.
import { createHash } from "node:crypto";

export const MAX_PROVIDER_RESULTS = 200;
const MAX_STRING_BYTES = 512;
const MAX_PROJECTION_BYTES = 16 * 1024;

export type ProviderCapabilityManifest = Readonly<{
  discover: true;
  importReadOnly: true;
  managedLease: boolean;
  write: false;
}>;

export type ProviderImportProjection = Readonly<{
  fingerprint: string;
  resource: Record<string, unknown>;
  metadata: Record<string, string | number | boolean | null>;
  capabilities: ProviderCapabilityManifest;
  host: string;
  port: number;
  database: string;
  engine: "postgres" | "mysql";
  sslmode: "verify-ca" | "verify-full";
}>;

export interface ProviderImportAdapter<Resource> {
  readonly provider: "neon" | "gcpCloudSql" | "planetScale";
  reconstruct(value: unknown): Resource;
  capabilities(resource: Resource): ProviderCapabilityManifest;
  importProjection(resource: Resource): ProviderImportProjection;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Invalid provider projection number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Invalid provider projection");
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function assertSafeValue(value: unknown, depth = 0): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid provider projection number");
    return;
  }
  if (typeof value === "string") {
    if (!value || Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("Invalid provider projection string");
    }
    return;
  }
  // Only provider-specific normalized scalar lists (currently Neon schemas) may
  // remain after reconstruction. Nested objects are never an import projection.
  if (Array.isArray(value) && depth === 0 && value.length > 0 && value.length <= 32) {
    value.forEach((item) => assertSafeValue(item, 1));
    return;
  }
  throw new Error("Provider projection contains nested or unsupported data");
}

function assertNoSecretKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(assertNoSecretKeys);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|authorization|credential/i.test(key)) {
      throw new Error("Provider projection contains secret-bearing data");
    }
    assertNoSecretKeys(item);
  }
}

export function providerResourceFingerprint(provider: string, resource: Record<string, unknown>) {
  if (!/^(neon|gcpCloudSql|planetScale)$/.test(provider)) throw new Error("Invalid provider");
  return createHash("sha256").update(`${provider}\n${canonical(resource)}`, "utf8").digest("hex");
}

export function readOnlyProjection(input: Omit<ProviderImportProjection, "fingerprint"> & { provider: string }) {
  if (!/^(neon|gcpCloudSql|planetScale)$/.test(input.provider)) throw new Error("Invalid provider");
  assertNoSecretKeys(input.resource);
  assertNoSecretKeys(input.metadata);
  Object.values(input.resource).forEach((value) => assertSafeValue(value));
  Object.values(input.metadata).forEach((value) => assertSafeValue(value));
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error("Invalid provider projection port");
  }
  const serialized = canonical({ resource: input.resource, metadata: input.metadata });
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECTION_BYTES) {
    throw new Error("Provider projection is too large");
  }
  return {
    ...input,
    fingerprint: providerResourceFingerprint(input.provider, input.resource),
  };
}
