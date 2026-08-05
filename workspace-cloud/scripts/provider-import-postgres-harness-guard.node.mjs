import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalLogicalDatabaseTarget,
  validateHarnessEnvironment,
} from "./provider-import-postgres-harness-guard.mjs";

const isolatedUrl = "postgresql://harness:secret@127.0.0.1:55432/dopedb_provider_import_test";
const base = {
  PROVIDER_IMPORT_TEST_DATABASE_URL: isolatedUrl,
  PROVIDER_IMPORT_TEST_DATABASE_ISOLATED: "1",
  PROVIDER_IMPORT_TEST_DATABASE_SENTINEL: "dedicated-fixture-marker",
};

test("canonical target ignores credentials and Neon pooler alias", () => {
  assert.equal(
    canonicalLogicalDatabaseTarget(
      "postgresql://a:first@ep-sample-pooler.example.test:5432/app",
    ),
    canonicalLogicalDatabaseTarget(
      "postgres://b:second@ep-sample.example.test/app?sslmode=require",
    ),
  );
});

test("guard accepts a dedicated confirmed database", () => {
  assert.deepEqual(validateHarnessEnvironment(base), {
    dedicatedUrl: isolatedUrl,
    sentinel: "dedicated-fixture-marker",
  });
});

test("guard rejects missing opt-in or short sentinel", () => {
  assert.throws(() => validateHarnessEnvironment({
    ...base,
    PROVIDER_IMPORT_TEST_DATABASE_ISOLATED: "0",
  }));
  assert.throws(() => validateHarnessEnvironment({
    ...base,
    PROVIDER_IMPORT_TEST_DATABASE_SENTINEL: "short",
  }));
});

test("guard rejects every alias of the application database", () => {
  for (const name of ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL"]) {
    assert.throws(() => validateHarnessEnvironment({
      ...base,
      [name]: "postgresql://app:other@127.0.0.1:55432/dopedb_provider_import_test",
    }));
  }
});

test("guard rejects non-PostgreSQL and incomplete URLs", () => {
  assert.throws(() => validateHarnessEnvironment({
    ...base,
    PROVIDER_IMPORT_TEST_DATABASE_URL: "mysql://harness@127.0.0.1/app",
  }));
  assert.throws(() => validateHarnessEnvironment({
    ...base,
    PROVIDER_IMPORT_TEST_DATABASE_URL: "postgresql://127.0.0.1/app",
  }));
});
