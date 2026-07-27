import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({ db: { execute: executeMock } }));

import {
  cleanupProviderDiscoveryReceipts,
} from "./provider-discovery-receipt-store";

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue({ rows: [{ deleted: 4 }] });
});

describe("provider discovery receipt cleanup", () => {
  it("reclaims only a bounded tenant batch while preserving the retry grace", async () => {
    await expect(cleanupProviderDiscoveryReceipts("workspace-id"))
      .resolves.toBe(4);
    const statement = executeMock.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(statement).sql
      .replace(/\s+/g, " ");
    expect(query).toContain('receipt."organization_id" =');
    expect(query).toContain('receipt."consumed_at" IS NULL AND receipt."expires_at" <= clock_timestamp()');
    expect(query).toContain('receipt."consumed_at" <= clock_timestamp() -');
    expect(query).toContain("interval '1 minute'");
    expect(query).toContain("FOR UPDATE SKIP LOCKED");
    expect(query).toContain("LIMIT");
    expect(query).toContain("DELETE FROM");
    expect(query).toContain("SELECT count(*)::int AS \"deleted\"");
    expect(new PgDialect().sqlToQuery(statement).params).toEqual(
      expect.arrayContaining(["workspace-id", 10, 50]),
    );
  });

  it("supports a bounded global maintenance sweep without a tenant parameter", async () => {
    await cleanupProviderDiscoveryReceipts();
    const statement = executeMock.mock.calls[0]?.[0] as SQL;
    const compiled = new PgDialect().sqlToQuery(statement);
    expect(compiled.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(compiled.params).toEqual([10, 50]);
  });
});
