// Kept outside Vitest's filename pattern; this suite uses Node's built-in runner.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertFinalizedLatestAsset,
  canonicalizeReleaseAssets,
  canonicalUpdaterAssetName,
  canonicalUpdaterUrl,
  finalizeUpdaterManifest,
  parseJsonWithoutDuplicateKeys,
} from "./finalize-updater-json.mjs";

const repository = "json-choi/dopedb";
const tag = "app-v0.4.0";
const version = "0.4.0";
const draftNamespace = "untagged-25a73115528edf589988";

function asset(suffix, id, namespace = tag) {
  const name = canonicalUpdaterAssetName(version, suffix);
  return {
    contentType: "application/octet-stream",
    digest: `sha256:${"a".repeat(64)}`,
    name,
    apiUrl: `https://api.github.com/repos/${repository}/releases/assets/${id}`,
    size: 17,
    url: canonicalUpdaterUrl(repository, namespace, name),
  };
}

function fixture(namespace = tag) {
  const arm = asset("aarch64.app.tar.gz", 101, namespace);
  const intel = asset("x64.app.tar.gz", 102, namespace);
  const windows = asset("x64-setup.exe", 103, namespace);
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
        { ...asset("aarch64.app.tar.gz.sig", 104, namespace) },
        { ...asset("x64.app.tar.gz.sig", 105, namespace) },
        { ...asset("x64-setup.exe.sig", 106, namespace) },
      ],
    },
  };
}

function latestAsset({
  contentType = "application/json",
  digest = `sha256:${"b".repeat(64)}`,
  namespace = tag,
  size = 17,
} = {}) {
  return {
    apiUrl: `https://api.github.com/repos/${repository}/releases/assets/107`,
    contentType,
    digest,
    name: "latest.json",
    size,
    url: canonicalUpdaterUrl(repository, namespace, "latest.json"),
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

test("accepts one strict GitHub draft namespace but emits only canonical tag URLs", () => {
  const source = fixture(draftNamespace);
  const result = finalizeUpdaterManifest({ ...source, repository, tag });
  for (const [platform, entry] of Object.entries(result.platforms)) {
    const suffix = {
      "darwin-aarch64": "aarch64.app.tar.gz",
      "darwin-x86_64": "x64.app.tar.gz",
      "windows-x86_64": "x64-setup.exe",
    }[platform];
    assert.equal(
      entry.url,
      canonicalUpdaterUrl(repository, tag, canonicalUpdaterAssetName(version, suffix)),
    );
    assert.equal(entry.url.includes(draftNamespace), false);
  }
  const canonicalAssets = canonicalizeReleaseAssets({
    releaseAssets: source.releaseAssets,
    repository,
    tag,
  });
  assert.ok(
    canonicalAssets.assets.every(
      (candidate) => candidate.url === canonicalUpdaterUrl(repository, tag, candidate.name),
    ),
  );
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
    /missing updater closure asset/,
  );
  const unsupported = fixture();
  unsupported.manifest.platforms["linux-x86_64"] = { signature: "x", url: "x" };
  assert.throws(
    () => finalizeUpdaterManifest({ ...unsupported, repository, tag }),
    /unsupported platform/,
  );
});

test("rejects updater assets without a safe downloadable content type and size", () => {
  for (const contentType of ["application/json", "application/problem+json", "text/html"]) {
    const unsafe = fixture();
    unsafe.releaseAssets.assets[0].contentType = contentType;
    assert.throws(
      () => finalizeUpdaterManifest({ ...unsafe, repository, tag }),
      /invalid release asset content type/,
      contentType,
    );
  }
  const noSize = fixture();
  noSize.releaseAssets.assets[0].size = 0;
  assert.throws(
    () => finalizeUpdaterManifest({ ...noSize, repository, tag }),
    /positive safe release asset size/,
  );
});

test("allows only known GitHub latest.json media-type essences", () => {
  for (const contentType of [
    "application/json",
    "application/json; charset=utf-8",
    "application/octet-stream",
    "application/zip",
  ]) {
    const source = fixture();
    source.releaseAssets.assets.push(latestAsset({ contentType }));
    assert.equal(
      finalizeUpdaterManifest({ ...source, repository, tag }).version,
      version,
      contentType,
    );
  }

  const missingContentType = fixture();
  const missingLatest = latestAsset();
  delete missingLatest.contentType;
  missingContentType.releaseAssets.assets.push(missingLatest);
  assert.throws(
    () => finalizeUpdaterManifest({ ...missingContentType, repository, tag }),
    /latest\.json has an invalid release asset content type/,
    "missing content type",
  );

  for (const contentType of [
    "",
    " text/html",
    "image/png",
    "application/json, application/zip",
    "application//json",
    "application/json;",
    "application/json; =x",
    "application/json; charset=utf-8; charset=utf-16",
  ]) {
    const source = fixture();
    source.releaseAssets.assets.push(latestAsset({ contentType }));
    assert.throws(
      () => finalizeUpdaterManifest({ ...source, repository, tag }),
      /latest\.json has an invalid release asset content type/,
      String(contentType),
    );
  }
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
  source.releaseAssets.assets.push(latestAsset({ size: bytes.length }));
  assert.throws(
    () => assertFinalizedLatestAsset({ source: bytes, releaseAssets: source.releaseAssets, repository, tag }),
    /latest.json bytes do not match/,
  );
});

test("validates finalized bytes against strict raw draft metadata", () => {
  const source = fixture(draftNamespace);
  const finalized = finalizeUpdaterManifest({ ...source, repository, tag });
  const bytes = Buffer.from(`${JSON.stringify(finalized, null, 2)}\n`);
  source.releaseAssets.assets.push(latestAsset({
    contentType: "application/json",
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    namespace: draftNamespace,
    size: bytes.length,
  }));
  assert.equal(
    assertFinalizedLatestAsset({
      source: bytes,
      releaseAssets: source.releaseAssets,
      repository,
      tag,
    }).version,
    version,
  );
});

test("rejects archive tag, target, and unsafe release URL mismatches", () => {
  const source = fixture();
  source.releaseAssets.assets[0].name = "DopeDB_0.4.1_aarch64.app.tar.gz";
  source.releaseAssets.assets[0].url = canonicalUpdaterUrl(
    repository,
    tag,
    source.releaseAssets.assets[0].name,
  );
  assert.throws(
    () => finalizeUpdaterManifest({ ...source, repository, tag }),
    /stale or unsupported updater asset/,
  );
  const nonPublic = fixture();
  nonPublic.releaseAssets.assets[0].url = "http://github.com/json-choi/dopedb/releases/download/app-v0.4.0/DopeDB_0.4.0_aarch64.app.tar.gz";
  assert.throws(
    () => finalizeUpdaterManifest({ ...nonPublic, repository, tag }),
    /repository-scoped GitHub release URL/,
  );
});

test("rejects mixed, malformed, and cross-repository draft asset URLs", () => {
  const mixed = fixture(draftNamespace);
  mixed.releaseAssets.assets[1].url = canonicalUpdaterUrl(
    repository,
    "untagged-aaaaaaaaaaaaaaaaaaaa",
    mixed.releaseAssets.assets[1].name,
  );
  assert.throws(
    () => finalizeUpdaterManifest({ ...mixed, repository, tag }),
    /share one tag or draft namespace/,
  );

  for (const transform of [
    (url) => url.replace("https://", "http://"),
    (url) => url.replace("github.com", "user:pass@github.com"),
    (url) => `${url}?download=1`,
    (url) => `${url}#archive`,
    (url) => url.replace(repository, "other-owner/dopedb"),
    (url) => url.replace(draftNamespace, "untagged-ABC"),
    (url, name) => url.replace(name, `%2F${name}`),
  ]) {
    const unsafe = fixture(draftNamespace);
    const candidate = unsafe.releaseAssets.assets[0];
    candidate.url = transform(candidate.url, candidate.name);
    assert.throws(
      () => finalizeUpdaterManifest({ ...unsafe, repository, tag }),
      /repository-scoped GitHub release URL|strict GitHub draft namespace/,
    );
  }
});

test("rejects release asset API URLs outside the exact repository asset endpoint", () => {
  for (const apiUrl of [
    "https://api.github.com/repos/other-owner/dopedb/releases/assets/101",
    `https://api.github.com/repos/${repository}/releases/assets/0`,
    `https://api.github.com/repos/${repository}/releases/assets/101?token=x`,
    `https://user:pass@api.github.com/repos/${repository}/releases/assets/101`,
    `https://github.com/repos/${repository}/releases/assets/101`,
  ]) {
    const source = fixture();
    source.releaseAssets.assets[0].apiUrl = apiUrl;
    source.manifest.platforms["darwin-aarch64"].url = apiUrl;
    assert.throws(
      () => finalizeUpdaterManifest({ ...source, repository, tag }),
      /repository-scoped GitHub release asset API/,
    );
  }
});

test("accepts exact Tauri bundle aliases, strips them, and rejects divergence", () => {
  const source = fixture();
  for (const [alias, platform] of Object.entries({
    "darwin-aarch64-app": "darwin-aarch64",
    "darwin-x86_64-app": "darwin-x86_64",
    "windows-x86_64-nsis": "windows-x86_64",
  })) {
    source.manifest.platforms[alias] = {
      ...source.manifest.platforms[platform],
    };
  }
  const finalized = finalizeUpdaterManifest({ ...source, repository, tag });
  assert.deepEqual(Object.keys(finalized.platforms), [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
  ]);

  const divergent = fixture();
  divergent.manifest.platforms["windows-x86_64-nsis"] = {
    ...divergent.manifest.platforms["windows-x86_64"],
    signature: "different-signature",
  };
  assert.throws(
    () => finalizeUpdaterManifest({ ...divergent, repository, tag }),
    /must duplicate windows-x86_64/,
  );
});

test("rejects unsupported platform aliases and stale updater assets", () => {
  const unsupported = fixture();
  unsupported.manifest.platforms["windows-x86_64-msi"] = {
    ...unsupported.manifest.platforms["windows-x86_64"],
  };
  assert.throws(
    () => finalizeUpdaterManifest({ ...unsupported, repository, tag }),
    /unsupported platform/,
  );

  const stale = fixture();
  stale.releaseAssets.assets.push(asset("x64-setup.exe", 999));
  stale.releaseAssets.assets.at(-1).name = "DopeDB_0.3.9_x64-setup.exe";
  stale.releaseAssets.assets.at(-1).url = canonicalUpdaterUrl(repository, tag, stale.releaseAssets.assets.at(-1).name);
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
