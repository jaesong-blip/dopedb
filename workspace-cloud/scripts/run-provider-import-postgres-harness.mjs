import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validateHarnessEnvironment,
} from "./provider-import-postgres-harness-guard.mjs";

const workspaceCloudDirectory = fileURLToPath(new URL("..", import.meta.url));
let harness;
try {
  harness = validateHarnessEnvironment(process.env);
} catch {
  console.error(
    "Refusing PostgreSQL harness: independently provisioned test database verification failed.",
  );
  process.exit(2);
}

// Used only by the adversarial subprocess tests. It can suppress work, never
// authorize it, and runs after every production guard has passed.
if (process.argv.includes("--check-guard-only")) process.exit(0);

const harnessEnvironment = {
  ...process.env,
  DATABASE_URL: harness.dedicatedUrl,
  DATABASE_URL_UNPOOLED: harness.dedicatedUrl,
  WORKSPACE_CLOUD_RUN_POSTGRES_IMPORT_HARNESS: "1",
};

function run(arguments_) {
  const result = spawnSync("pnpm", arguments_, {
    cwd: workspaceCloudDirectory,
    env: harnessEnvironment,
    stdio: "inherit",
  });
  if (result.error) {
    console.error("PostgreSQL harness command could not start.");
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The target must be independently provisioned, pre-migrated, and marked by the
// sentinel checked inside the test before any production module or write loads.
run([
  "--dir",
  "..",
  "exec",
  "vitest",
  "run",
  "workspace-cloud/lib/provider-import-postgres.concurrent.test.ts",
]);
