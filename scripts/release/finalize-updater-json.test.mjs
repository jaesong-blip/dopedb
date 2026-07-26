import assert from "node:assert/strict";
import test from "node:test";

import { finalizeUpdaterManifest } from "./finalize-updater-json.mjs";

const repository = "json-choi/dopedb";
const tag = "app-v0.4.0";
const macApiUrl =
  "https://api.github.com/repos/json-choi/dopedb/releases/assets/101";
const windowsApiUrl =
  "https://api.github.com/repos/json-choi/dopedb/releases/assets/102";
const macUrl =
  "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/DopeDB_0.4.0_aarch64.app.tar.gz";
const windowsUrl =
  "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/DopeDB_0.4.0_x64-setup.exe";

function fixture() {
  return {
    manifest: {
      version: "0.4.0",
      notes: "release",
      pub_date: "2026-07-26T00:00:00Z",
      platforms: {
        "darwin-aarch64": { signature: "signed-mac", url: macApiUrl },
        "darwin-x86_64": { signature: "signed-mac", url: macApiUrl },
        "windows-x86_64": {
          signature: "signed-windows",
          url: windowsApiUrl,
        },
      },
    },
    releaseAssets: {
      assets: [
        {
          name: "DopeDB_0.4.0_aarch64.app.tar.gz",
          apiUrl: macApiUrl,
          url: macUrl,
        },
        {
          name: "DopeDB_0.4.0_x64-setup.exe",
          apiUrl: windowsApiUrl,
          url: windowsUrl,
        },
      ],
    },
  };
}

test("rewrites API asset URLs to public release-download URLs", () => {
  const result = finalizeUpdaterManifest({
    ...fixture(),
    repository,
    tag,
  });

  assert.equal(result.platforms["darwin-aarch64"].url, macUrl);
  assert.equal(result.platforms["darwin-x86_64"].url, macUrl);
  assert.equal(result.platforms["windows-x86_64"].url, windowsUrl);
  assert.equal(result.notes, "release");
});

test("accepts an already finalized manifest deterministically", () => {
  const source = fixture();
  for (const entry of Object.values(source.manifest.platforms)) {
    entry.url = entry.url === macApiUrl ? macUrl : windowsUrl;
  }

  assert.deepEqual(
    finalizeUpdaterManifest({ ...source, repository, tag }),
    source.manifest,
  );
});

test("rejects a tag and manifest version mismatch", () => {
  assert.throws(
    () =>
      finalizeUpdaterManifest({
        ...fixture(),
        repository,
        tag: "app-v0.4.1",
      }),
    /does not match release tag/,
  );
});

test("rejects missing updater signatures", () => {
  const source = fixture();
  source.manifest.platforms["darwin-aarch64"].signature = "";

  assert.throws(
    () => finalizeUpdaterManifest({ ...source, repository, tag }),
    /signature must be a non-empty string/,
  );
});

test("rejects unknown or non-public asset URLs", () => {
  const source = fixture();
  source.manifest.platforms["darwin-aarch64"].url =
    "https://example.invalid/update.tar.gz";

  assert.throws(
    () => finalizeUpdaterManifest({ ...source, repository, tag }),
    /unknown release asset URL/,
  );
});

test("requires every supported stable updater platform", () => {
  const source = fixture();
  delete source.manifest.platforms["windows-x86_64"];

  assert.throws(
    () => finalizeUpdaterManifest({ ...source, repository, tag }),
    /missing required platform windows-x86_64/,
  );
});
