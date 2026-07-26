// Kept outside Vitest's filename pattern; this suite uses Node's built-in runner.
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFinalizedLatestAsset,
  canonicalUpdaterAssetName,
  canonicalUpdaterUrl,
  finalizeUpdaterManifest,
  parseJsonWithoutDuplicateKeys,
} from "./finalize-updater-json.mjs";

const repository = "json-choi/dopedb";
const tag = "app-v0.4.0";
const version = "0.4.0";

function asset(suffix, id) {
  const name = canonicalUpdaterAssetName(version, suffix);
  return {
    contentType: "application/octet-stream",
    digest: `sha256:${"a".repeat(64)}`,
    name,
    apiUrl: `https://api.github.com/repos/${repository}/releases/assets/${id}`,
    size: 17,
    url: canonicalUpdaterUrl(repository, tag, name),
  };
}

function fixture() {
  const arm = asset("aarch64.app.tar.gz", 101);
  const intel = asset("x64.app.tar.gz", 102);
  const windows = asset("x64-setup.exe", 103);
  return {
    manifest: {
      version,
      notes: "release",
      pub_date: "2026-07-26T00:00:00Z",
      platforms: {
        "darwin-aarch64": { signature: "signed-arm", url: arm.apiUrl },
        "darwin-x86_64": { signature: "signed-intel", url: intel.apiUrl },
        "windows-x86_64": { signature: "signed-windows", url: windows.apiUrl },
      },
    },
    releaseAssets: {
      assets: [
        arm,
        intel,
        windows,
        { ...asset("aarch64.app.tar.gz.sig", 104) },
        { ...asset("x64.app.tar.gz.sig", 105) },
        { ...asset("x64-setup.exe.sig", 106) },
      ],
    },
  };
}

test("rewrites API asset URLs to canonical public release-download URLs", () => {
  const result = finalizeUpdaterManifest({ ...fixture(), repository, tag });
  assert.deepEqual(Object.keys(result.platforms), [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
  ]);
  assert.equal(
    result.platforms["darwin-aarch64"].url,
    canonicalUpdaterUrl(repository, tag, canonicalUpdaterAssetName(version, "aarch64.app.tar.gz")),
  );
  assert.equal(result.notes, "release");
});

test("accepts an already finalized manifest deterministically", () => {
  const source = fixture();
  for (const [platform, entry] of Object.entries(source.manifest.platforms)) {
    const suffix = {
      "darwin-aarch64": "aarch64.app.tar.gz",
      "darwin-x86_64": "x64.app.tar.gz",
      "windows-x86_64": "x64-setup.exe",
    }[platform];
    entry.url = canonicalUpdaterUrl(repository, tag, canonicalUpdaterAssetName(version, suffix));
  }
  assert.deepEqual(finalizeUpdaterManifest({ ...source, repository, tag }), source.manifest);
});

test("rejects a tag and manifest version mismatch", () => {
  assert.throws(
    () => finalizeUpdaterManifest({ ...fixture(), repository, tag: "app-v0.4.1" }),
    /does not match release tag/,
  );
});

test("rejects a non-canonical stable repository", () => {
  assert.throws(
    () => finalizeUpdaterManifest({ ...fixture(), repository: "fork/dopedb", tag }),
    /stable updater repository/,
  );
});

test("rejects missing archive signatures and unsupported platform keys", () => {
  const missingSignature = fixture();
  missingSignature.releaseAssets.assets.pop();
  assert.throws(
    () => finalizeUpdaterManifest({ ...missingSignature, repository, tag }),
    /missing canonical updater closure asset/,
  );
  const unsupported = fixture();
  unsupported.manifest.platforms["linux-x86_64"] = { signature: "x", url: "x" };
  assert.throws(
    () => finalizeUpdaterManifest({ ...unsupported, repository, tag }),
    /unsupported platform/,
  );
});

test("rejects updater assets without a safe downloadable content type and size", () => {
  const unsafe = fixture();
  unsafe.releaseAssets.assets[0].contentType = "application/json";
  assert.throws(
    () => finalizeUpdaterManifest({ ...unsafe, repository, tag }),
    /invalid release asset content type/,
  );
  const noSize = fixture();
  noSize.releaseAssets.assets[0].size = 0;
  assert.throws(
    () => finalizeUpdaterManifest({ ...noSize, repository, tag }),
    /positive safe release asset size/,
  );
});

test("rejects missing or malformed SHA-256 asset digests", () => {
  const missing = fixture();
  delete missing.releaseAssets.assets[0].digest;
  assert.throws(
    () => finalizeUpdaterManifest({ ...missing, repository, tag }),
    /strict sha256 asset digest/,
  );
  const malformed = fixture();
  malformed.releaseAssets.assets[0].digest = "sha256:ABC";
  assert.throws(
    () => finalizeUpdaterManifest({ ...malformed, repository, tag }),
    /strict sha256 asset digest/,
  );
});

test("requires refreshed latest.json size and SHA-256 metadata", () => {
  const source = fixture();
  const finalized = finalizeUpdaterManifest({ ...source, repository, tag });
  const bytes = Buffer.from(`${JSON.stringify(finalized, null, 2)}\n`);
  source.releaseAssets.assets.push({
    apiUrl: "https://api.github.com/assets/latest",
    contentType: "application/octet-stream",
    digest: `sha256:${"b".repeat(64)}`,
    name: "latest.json",
    size: bytes.length,
    url: canonicalUpdaterUrl(repository, tag, "latest.json"),
  });
  assert.throws(
    () => assertFinalizedLatestAsset({ source: bytes, releaseAssets: source.releaseAssets, repository, tag }),
    /latest.json bytes do not match/,
  );
});

test("rejects archive tag, target, and public URL mismatches", () => {
  const source = fixture();
  source.releaseAssets.assets[0].name = "DopeDB_0.4.1_aarch64.app.tar.gz";
  assert.throws(
    () => finalizeUpdaterManifest({ ...source, repository, tag }),
    /stale or unsupported updater asset/,
  );
  const nonPublic = fixture();
  nonPublic.releaseAssets.assets[0].url = "http://github.com/json-choi/dopedb/releases/download/app-v0.4.0/DopeDB_0.4.0_aarch64.app.tar.gz";
  assert.throws(
    () => finalizeUpdaterManifest({ ...nonPublic, repository, tag }),
    /must use its canonical public URL/,
  );
});

test("rejects legacy aliases and stale updater assets", () => {
  const source = fixture();
  source.manifest.platforms["windows-x86_64-nsis"] = {
    ...source.manifest.platforms["windows-x86_64"],
  };
  assert.throws(
    () => finalizeUpdaterManifest({ ...source, repository, tag }),
    /unsupported platform/,
  );
  const stale = fixture();
  stale.releaseAssets.assets.push(asset("x64-setup.exe", 999));
  stale.releaseAssets.assets.at(-1).name = "DopeDB_0.3.9_x64-setup.exe";
  stale.releaseAssets.assets.at(-1).url = canonicalUpdaterUrl(repository, "app-v0.3.9", stale.releaseAssets.assets.at(-1).name);
  assert.throws(() => finalizeUpdaterManifest({ ...stale, repository, tag }), /stale or unsupported/);
});

test("rejects malformed and duplicate-key updater JSON", () => {
  assert.throws(() => parseJsonWithoutDuplicateKeys('{"platforms":'), /Unexpected|expected/);
  assert.throws(
    () => parseJsonWithoutDuplicateKeys('{"platforms":{"windows-x86_64":{},"windows-x86_64":{}}}'),
    /duplicate JSON key windows-x86_64/,
  );
});

test("rejects magic keys and inherited-only platform payloads", () => {
  assert.throws(
    () => parseJsonWithoutDuplicateKeys('{"__proto__":{"platforms":{}}}'),
    /forbidden JSON key/,
  );
  const source = fixture();
  source.manifest.platforms = Object.create(source.manifest.platforms);
  assert.throws(
    () => finalizeUpdaterManifest({ ...source, repository, tag }),
    /missing required platform/,
  );
});
