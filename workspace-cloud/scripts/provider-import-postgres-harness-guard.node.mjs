import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DATABASE_URL_ENV_NAMES,
  canonicalLogicalDatabaseTarget,
} from "./provider-import-postgres-harness-guard.mjs";

const runner = fileURLToPath(
  new URL("./run-provider-import-postgres-harness.mjs", import.meta.url),
);
const baseline = {
  PROVIDER_IMPORT_TEST_DATABASE_ISOLATED: "1",
  PROVIDER_IMPORT_TEST_DATABASE_SENTINEL: "isolated-branch-marker-0123456789",
};
const databaseEnvironmentNames = [...DEFAULT_DATABASE_URL_ENV_NAMES];

function runGuard(overrides) {
  const environment = { ...process.env, ...baseline, ...overrides, PATH: "" };
  for (const name of databaseEnvironmentNames) {
    if (!(name in overrides)) delete environment[name];
  }
  const result = spawnSync(
    process.execPath,
    [runner, "--check-guard-only"],
    { env: environment, encoding: "utf8" },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

test("canonical identity ignores roles, passwords, options, query order, and Neon pooler routing", () => {
  const pooled = canonicalLogicalDatabaseTarget(
    "postgresql://app:old@ep-safe-pooler.us-east-2.aws.neon.tech/app?sslmode=require&channel_binding=require",
  );
  const direct = canonicalLogicalDatabaseTarget(
    "postgres://test_role:new@EP-SAFE.us-east-2.aws.neon.tech:5432/app?channel_binding=disable&sslmode=verify-full",
  );
  assert.equal(pooled, direct);
});

test("runner rejects a Neon pooler/direct alias before any child process spawn", () => {
  const result = runGuard({
    DATABASE_URL:
      "postgresql://app:production@ep-safe-pooler.us-east-2.aws.neon.tech/app?sslmode=require",
    PROVIDER_IMPORT_TEST_DATABASE_URL:
      "postgresql://app:different@ep-safe.us-east-2.aws.neon.tech:5432/app?channel_binding=require",
  });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.output, /ep-safe|production|different/);
});

test("runner rejects an exact default DSN before any child process spawn", () => {
  const url =
    "postgresql://app:production@ep-safe.us-east-2.aws.neon.tech/app";
  const result = runGuard({
    DATABASE_URL: url,
    PROVIDER_IMPORT_TEST_DATABASE_URL: url,
  });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.output, /ep-safe|production/);
});

test("runner rejects password and reordered query variants of every default target", () => {
  for (const name of databaseEnvironmentNames) {
    const result = runGuard({
      [name]:
        "postgresql://app:first@db.example.test:5432/workspace?sslmode=require&options=one",
      PROVIDER_IMPORT_TEST_DATABASE_URL:
        "postgres://app:second@DB.EXAMPLE.TEST/workspace?options=two&sslmode=disable",
    });
    assert.equal(result.status, 2, name);
    assert.doesNotMatch(result.output, /db\.example|first|second/, name);
  }
});

test("runner rejects a different role on the same decoded database pathname", () => {
  const result = runGuard({
    DATABASE_URL:
      "postgresql://production%2Duser:first@db.example.test/workspace%2Dtest",
    PROVIDER_IMPORT_TEST_DATABASE_URL:
      "postgresql://isolated-user:second@db.example.test:5432/workspace-test?sslmode=require",
  });
  assert.equal(result.status, 2);
});

test("a distinct branch or database requires explicit isolation and sentinel", () => {
  const distinctBranch = {
    DATABASE_URL:
      "postgresql://app:production@ep-production.us-east-2.aws.neon.tech/app",
    PROVIDER_IMPORT_TEST_DATABASE_URL:
      "postgresql://app:test@ep-isolated.us-east-2.aws.neon.tech/app",
  };
  assert.equal(runGuard({
    ...distinctBranch,
    PROVIDER_IMPORT_TEST_DATABASE_ISOLATED: "0",
  }).status, 2);
  assert.equal(runGuard({
    ...distinctBranch,
    PROVIDER_IMPORT_TEST_DATABASE_SENTINEL: "",
  }).status, 2);
  assert.equal(runGuard(distinctBranch).status, 0);
  assert.equal(runGuard({
    DATABASE_URL:
      "postgresql://app:production@ep-production.us-east-2.aws.neon.tech/app",
    PROVIDER_IMPORT_TEST_DATABASE_URL:
      "postgresql://app:test@ep-production.us-east-2.aws.neon.tech/app_test",
  }).status, 0);
});
