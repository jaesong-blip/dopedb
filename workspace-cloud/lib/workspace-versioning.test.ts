import { describe, expect, it } from "vitest";

import {
  canonicalHash,
  canonicalJson,
  connectionVersionPayload,
  parseExpectedRevision,
} from "./workspace-versioning";

const template = {
  name: "Analytics", engine: "postgres", provider: "neon", driverId: null,
  host: "db.example.com", port: 5432, database: "analytics", sslmode: "require",
  readonlyDefault: true, allowWrites: false, env: "prod", schemaGroup: null,
} as const;

describe("workspace version payload", () => {
  it("hashes a canonical redacted payload independent of property order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } }))
      .toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(canonicalHash({ b: 2, a: 1 })).toBe(canonicalHash({ a: 1, b: 2 }));
  });

  it("records deletion without adding a secret-bearing field", () => {
    const payload = connectionVersionPayload(template, true);
    expect(payload).toMatchObject({ deleted: true, host: "db.example.com" });
    expect(JSON.stringify(payload)).not.toMatch(/password|token|secret/i);
  });

  it("requires a quoted exact If-Match revision", () => {
    expect(parseExpectedRevision(new Request("https://example.test", {
      headers: { "if-match": '"17"' },
    }))).toBe(17);
    expect(parseExpectedRevision(new Request("https://example.test"))).toBeNull();
    expect(() => parseExpectedRevision(new Request("https://example.test", {
      headers: { "if-match": "17" },
    }))).toThrow(/If-Match/);
    for (const value of [
      'W/"17"', "*", '"17", "18"', "17", '"9007199254740992"', '"-1"',
    ]) {
      expect(() => parseExpectedRevision(new Request("https://example.test", {
        headers: { "if-match": value },
      }))).toThrow(/If-Match|Invalid expected revision/);
    }
  });
});
