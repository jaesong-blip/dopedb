// Waits only while GitHub's draft asset metadata catches up with a local,
// already-finalized latest.json; structural updater-closure failures stop now.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  assertFinalizedLatestAsset,
  canonicalizeReleaseAssets,
  parseJsonWithoutDuplicateKeys,
} from "./finalize-updater-json.mjs";

const execFileAsync = promisify(execFile);
const STALE_LATEST_MESSAGE = "latest.json bytes do not match refreshed release metadata";

function fail(message) {
  throw new Error(message);
}

export function isStaleLatestMetadata(error) {
  return error instanceof Error && error.message === STALE_LATEST_MESSAGE;
}

export async function waitForFinalizedLatestAsset({
  deadlineMs = 55_000,
  loadAssets,
  maxAttempts = 8,
  now = Date.now,
  repository,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  source,
  tag,
}) {
  const deadline = now() + deadlineMs;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (now() >= deadline) {
      fail("latest.json asset metadata did not converge before the bounded draft deadline");
    }
    const assets = await loadAssets();
    if (now() > deadline) {
      fail("latest.json asset metadata did not converge before the bounded draft deadline");
    }
    try {
      const manifest = assertFinalizedLatestAsset({
        source,
        releaseAssets: assets,
        repository,
        tag,
      });
      return {
        assets: canonicalizeReleaseAssets({
          releaseAssets: assets,
          repository,
          tag,
        }),
        manifest,
      };
    } catch (error) {
      if (!isStaleLatestMetadata(error)) throw error;
      const remaining = deadline - now();
      if (attempt + 1 === maxAttempts || remaining <= 0) {
        fail("latest.json asset metadata did not converge before the bounded draft deadline");
      }
      await sleep(Math.min(1_000 * 2 ** attempt, remaining, 60_000));
    }
  }
  fail("latest.json asset metadata did not converge before the bounded draft deadline");
}

function argumentsFor(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name)) {
      fail(`invalid argument ${name ?? "<missing>"}`);
    }
    values.set(name, value);
  }
  const required = ["assets", "manifest", "repository", "tag"];
  for (const name of required) {
    if (!values.get(`--${name}`)) fail(`missing --${name}`);
  }
  return Object.fromEntries(required.map((name) => [name, values.get(`--${name}`)]));
}

async function runCli() {
  const options = argumentsFor(process.argv.slice(2));
  const source = await readFile(options.manifest);
  const loadAssets = async () => {
    const { stdout } = await execFileAsync("gh", [
      "release", "view", options.tag, "--repo", options.repository, "--json", "assets",
    ], { maxBuffer: 1_048_576, timeout: 10_000 });
    return { raw: stdout, value: parseJsonWithoutDuplicateKeys(stdout) };
  };
  const result = await waitForFinalizedLatestAsset({
    loadAssets: async () => (await loadAssets()).value,
    repository: options.repository,
    source,
    tag: options.tag,
  });
  await writeFile(options.assets, `${JSON.stringify(result.assets)}\n`, { mode: 0o600 });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
