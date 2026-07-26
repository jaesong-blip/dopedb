import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalUpdaterAssetName,
  canonicalUpdaterUrl,
  finalizeUpdaterManifest,
} from "./finalize-updater-json.mjs";
import { waitForFinalizedLatestAsset } from "./wait-for-finalized-latest.mjs";

const repository = "json-choi/dopedb";
const tag = "app-v0.4.0";
const version = "0.4.0";

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture() {
  const assets = [];
  const platforms = {};
  for (const [platform, suffix] of Object.entries({
    "darwin-aarch64": "aarch64.app.tar.gz",
    "darwin-x86_64": "x64.app.tar.gz",
    "windows-x86_64": "x64-setup.exe",
  })) {
    const name = canonicalUpdaterAssetName(version, suffix);
    const payload = suffix.includes("setup") ? Buffer.from("MZ") : Buffer.from([0x1f, 0x8b]);
    const signature = Buffer.from(`signature-${platform}`);
    const url = canonicalUpdaterUrl(repository, tag, name);
    assets.push({ apiUrl: `https://api.github.com/assets/${assets.length}`, contentType: "application/octet-stream", digest: digest(payload), name, size: payload.length, url });
    assets.push({ apiUrl: `https://api.github.com/assets/${assets.length}`, contentType: "application/octet-stream", digest: digest(signature), name: `${name}.sig`, size: signature.length, url: canonicalUpdaterUrl(repository, tag, `${name}.sig`) });
    platforms[platform] = { signature: signature.toString("base64"), url };
  }
  const manifest = finalizeUpdaterManifest({ manifest: { notes: "test", platforms, version }, releaseAssets: { assets }, repository, tag });
  const source = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  assets.push({ apiUrl: "https://api.github.com/assets/latest", contentType: "application/octet-stream", digest: digest(source), name: "latest.json", size: source.length, url: canonicalUpdaterUrl(repository, tag, "latest.json") });
  return { assets: { assets }, source };
}

test("retries only the stale draft latest.json metadata until the exact local bytes converge", async () => {
  const fresh = fixture();
  const stale = structuredClone(fresh.assets);
  stale.assets.at(-1).digest = `sha256:${"0".repeat(64)}`;
  const waits = [];
  let calls = 0;
  const result = await waitForFinalizedLatestAsset({
    loadAssets: async () => (calls++ === 0 ? stale : fresh.assets),
    now: () => 0,
    repository,
    sleep: async (milliseconds) => waits.push(milliseconds),
    source: fresh.source,
    tag,
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1_000]);
  assert.equal(result.manifest.version, version);
});

test("does not retry a structural draft closure failure or sleep beyond the deadline", async () => {
  const fresh = fixture();
  const structural = structuredClone(fresh.assets);
  structural.assets.pop();
  await assert.rejects(
    waitForFinalizedLatestAsset({
      loadAssets: async () => structural,
      repository,
      sleep: async () => assert.fail("structural failure must not retry"),
      source: fresh.source,
      tag,
    }),
    /missing latest\.json asset metadata/,
  );
  const stale = structuredClone(fresh.assets);
  stale.assets.at(-1).size += 1;
  await assert.rejects(
    waitForFinalizedLatestAsset({
      deadlineMs: 0,
      loadAssets: async () => stale,
      now: () => 0,
      repository,
      sleep: async () => assert.fail("expired deadline must not sleep"),
      source: fresh.source,
      tag,
    }),
    /did not converge before the bounded draft deadline/,
  );
});
