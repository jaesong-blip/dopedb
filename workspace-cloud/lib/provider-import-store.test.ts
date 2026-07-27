import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const transactionMock = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({ neonSql: { transaction: transactionMock } }));

import { importProviderReceipt } from "./provider-import-store";
import { canonicalHash, canonicalJson } from "./workspace-versioning";

const input = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  integrationId: "22222222-2222-4222-8222-222222222222",
  receiptId: "33333333-3333-4333-8333-333333333333",
  idempotencyKey: "provider-import-idempotency-0001",
  name: "Neon · app",
  authority: { sessionId: "session-id", userId: "admin-user", membershipId: "member-id", role: "admin" },
};

const row = {
  kind: "imported", id: "44444444-4444-4444-8444-444444444444", name: "Neon · app", engine: "postgres",
  provider: "neon", driverId: null, host: "neon.managed.invalid", port: "5432",
  databaseName: "app", sslmode: "verify-full", readonlyDefault: true, allowWrites: false,
  environment: null, schemaGroup: null, credentialMode: "managed", contentRevision: "1",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  transactionMock.mockImplementation(async (build) => {
    const queries = build((strings: TemplateStringsArray, ...params: unknown[]) => ({
      text: strings.join("?"), params,
    }));
    return [[], [row, ...queries.slice(2)]];
  });
});

describe("atomic provider receipt import", () => {
  it("cannot migrate or mutate the default application database from the harness", () => {
    const packageJson = JSON.parse(readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as { scripts: Record<string, string> };
    const runner = readFileSync(
      new URL("../scripts/run-provider-import-postgres-harness.mjs", import.meta.url),
      "utf8",
    );
    const guard = readFileSync(
      new URL("../scripts/provider-import-postgres-harness-guard.mjs", import.meta.url),
      "utf8",
    );
    const harness = readFileSync(
      new URL("./provider-import-postgres.concurrent.test.ts", import.meta.url),
      "utf8",
    );
    expect(packageJson.scripts["test:postgres-import"]).toBe(
      "node scripts/run-provider-import-postgres-harness.mjs",
    );
    expect(runner).toContain("validateHarnessEnvironment");
    expect(runner).toContain("DATABASE_URL_UNPOOLED: harness.dedicatedUrl");
    expect(runner).not.toContain('run(["db:migrate"])');
    expect(guard).toContain("PROVIDER_IMPORT_TEST_DATABASE_ISOLATED");
    expect(guard).toContain("PROVIDER_IMPORT_TEST_DATABASE_URL");
    expect(guard).toContain("PROVIDER_IMPORT_TEST_DATABASE_SENTINEL");
    expect(guard).toContain('labels[0]?.endsWith("-pooler")');
    expect(guard).not.toContain("password: url.password");
    expect(harness).toContain("const dedicatedDatabaseUrl =");
    expect(harness).toContain('"isolated_database_sentinel"');
    expect(harness).toContain("Dedicated PostgreSQL harness database is not pre-migrated");
    expect(harness).not.toContain(
      "Boolean(process.env.DATABASE_URL)",
    );
    expect(harness).not.toContain("neon(process.env.DATABASE_URL");
  });

  it("uses ordered lock/revalidation then fresh-snapshot mutation in one Neon transaction", async () => {
    await expect(importProviderReceipt(input)).resolves.toMatchObject({
      kind: "imported", connection: { port: 5432, contentRevision: 1 },
    });
    expect(transactionMock).toHaveBeenCalledOnce();
    const queries = transactionMock.mock.results[0];
    expect(queries.type).toBe("return");
    const build = transactionMock.mock.calls[0]![0];
    const captured = build((strings: TemplateStringsArray) => strings.join("?"));
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain("integration_lock AS MATERIALIZED");
    expect(captured[0]).toContain("resource_lock AS MATERIALIZED");
    expect(captured[0]).toContain("key_lock AS MATERIALIZED");
    expect(captured[0]).toContain("FOR UPDATE OF receipt, integration, resource");
    expect(captured[0]).toContain('receipt."integration_generation" = integration."generation"');
    expect(captured[0]).toContain('integration."refresh_phase" = \'idle\'');
    expect(captured[0].indexOf("integration_lock AS MATERIALIZED"))
      .toBeLessThan(captured[0].indexOf("resource_lock AS MATERIALIZED"));
    expect(captured[0].indexOf("member_lock AS MATERIALIZED"))
      .toBeLessThan(captured[0].indexOf("integration_lock AS MATERIALIZED"));
    expect(captured[0].indexOf("resource_lock AS MATERIALIZED"))
      .toBeLessThan(captured[0].indexOf("key_lock AS MATERIALIZED"));
    expect(captured[0]).toContain("provider-import-resource:");
    expect(captured[1]).toContain("prior_key AS MATERIALIZED");
    expect(captured[1]).toContain('receipt."integration_generation" = integration."generation"');
    expect(captured[1]).toContain('integration."refresh_phase" = \'idle\'');
    expect(captured[1]).toContain('resource."provider" = integration."provider"');
    expect(captured[1]).toContain('resource."redacted_metadata" -> \'production\' = \'false\'::jsonb');
    expect(captured[1]).toContain('resource."capability_manifest" -> \'importReadOnly\' = \'true\'::jsonb');
    expect(captured[1]).toContain('resource."capability_manifest" -> \'write\' = \'false\'::jsonb');
    expect(captured[1]).toContain('resource."capability_manifest" -> \'managedLease\' = \'true\'::jsonb');
    expect(captured[1]).toContain("'integrationGeneration'");
    expect(captured[1]).toContain("'integrationId'");
    expect(captured[1]).toContain("'organizationId'");
    expect(captured[1]).toContain("'resourceId'");
    expect(captured[1]).toContain("'name'");
    expect(captured[1]).toContain("'mode', 'managed'");
    expect(captured[1]).toContain('scope."resourceId" = key."resource_id"');
    expect(captured[1]).toContain('connection."credential_mode" IN (\'managed\', \'member_local\')');
    expect(captured[1]).toContain('connection."provider_integration_id" =');
    expect(captured[1]).toContain('connection."provider_resource_id" = scope."resourceId"');
    expect(captured[1]).toContain('connection."provider" = scope."provider"');
    expect(captured[1]).toContain('connection."provider_resource" = scope."resource"');
    expect(captured[1]).toContain('connection."readonly_default" = TRUE');
    expect(captured[1]).toContain('connection."allow_writes" = FALSE');
    expect(captured[1]).toContain("resource_conflict AS MATERIALIZED");
    expect(captured[1]).toContain("connection_grant AS MATERIALIZED");
    expect(captured[1]).toContain(
      'JOIN connection_grant ON connection_grant."connection_id" = inserted."id"',
    );
    expect(captured[1]).not.toMatch(/\bgrant\s+AS\s+MATERIALIZED\b/i);
    expect(captured[1]).not.toContain("1 / CASE");
  });

  it("returns typed domain conflicts rather than converting database errors into expected control flow", async () => {
    transactionMock.mockImplementationOnce(async () => [[], [{ kind: "idempotency_conflict" }]]);
    await expect(importProviderReceipt(input)).resolves.toEqual({ kind: "idempotency_conflict" });
    transactionMock.mockImplementationOnce(async () => [[], [{ kind: "resource_conflict" }]]);
    await expect(importProviderReceipt(input)).resolves.toEqual({ kind: "resource_conflict" });
  });

  it("returns an equivalent connection response for an exact idempotent replay", async () => {
    const first = await importProviderReceipt(input);
    const replay = await importProviderReceipt(input);
    expect(replay).toEqual(first);
  });

  it("keeps an exact replay valid after the imported target becomes member-local", async () => {
    await importProviderReceipt(input);
    const build = transactionMock.mock.calls[0]![0];
    const [, mutation] = build((strings: TemplateStringsArray) => strings.join("?"));
    expect(mutation).toContain("connection.\"credential_mode\" IN ('managed', 'member_local')");
    expect(mutation).toContain('EXISTS (SELECT 1 FROM prior_key) AND EXISTS (SELECT 1 FROM scope)');
    expect(mutation).toContain('WHERE NOT EXISTS (SELECT 1 FROM scope)');
  });

  it("fails closed when the current canonical resource no longer proves read-only non-production import", async () => {
    await importProviderReceipt(input);
    const build = transactionMock.mock.calls[0]![0];
    const [, mutation] = build((strings: TemplateStringsArray) => strings.join("?"));
    for (const predicate of [
      'resource."redacted_metadata" -> \'production\' = \'false\'::jsonb',
      'resource."capability_manifest" -> \'importReadOnly\' = \'true\'::jsonb',
      'resource."capability_manifest" -> \'write\' = \'false\'::jsonb',
      'resource."capability_manifest" -> \'managedLease\' = \'true\'::jsonb',
    ]) expect(mutation).toContain(predicate);
    expect(mutation).toContain('UPDATE "workspace_control"."workspace_provider_discovery_receipt" receipt SET "consumed_at" = now()');
    expect(mutation).toContain('FROM fresh WHERE receipt."id" = fresh."receiptId"');
  });

  it("uses the durable resource id for conflicts and the full canonical link for replay", async () => {
    await importProviderReceipt(input);
    const build = transactionMock.mock.calls[0]![0];
    const [, mutation] = build((strings: TemplateStringsArray) => strings.join("?"));
    // A disconnect clears provider_resource_id alongside provider_resource. The
    // fresh receipt can therefore import again instead of seeing stale JSON.
    expect(mutation).toContain('connection."provider_resource_id" = scope."resourceId"');
    expect(mutation).toContain('connection."provider_resource" = scope."resource"');
  });

  it("returns a typed fresh import after a soft-deleted binding no longer owns the resource", async () => {
    await expect(importProviderReceipt({
      ...input,
      idempotencyKey: "provider-import-idempotency-0002",
    })).resolves.toMatchObject({
      kind: "imported",
      connection: { id: row.id },
    });
    const build = transactionMock.mock.calls[0]![0];
    const [, mutation] = build((strings: TemplateStringsArray) => strings.join("?"));
    expect(mutation).toContain('connection."provider_resource_id" = scope."resourceId"');
    expect(mutation).toContain('connection."deleted_at" IS NULL');
  });

  it("keeps canonical Unicode/escaping payload construction in the mutation command", async () => {
    await importProviderReceipt({ ...input, name: "한글 \"quoted\" \\ slash" });
    const build = transactionMock.mock.calls[0]![0];
    const [, mutation] = build((strings: TemplateStringsArray) => strings.join("?"));
    expect(mutation).toContain('"allowWrites":false');
    expect(mutation).toContain("encode(digest(payload.\"text\", 'sha256'), 'hex')");
    expect(mutation).toContain('to_json(inserted."name")::text');
    const payload = {
      allowWrites: false, database: "한글 \"quoted\" \\ slash", deleted: false, driverId: null,
      engine: "postgres", env: null, host: "neon.managed.invalid", name: "한글 \"quoted\" \\ slash",
      port: 5432, provider: "neon", readonlyDefault: true, schemaGroup: null, sslmode: "verify-full",
    };
    expect(canonicalHash(payload)).toBe(createHash("sha256").update(canonicalJson(payload)).digest("hex"));
  });
});
