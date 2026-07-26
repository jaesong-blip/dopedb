// Finalizes Tauri updater metadata before a draft release becomes immutable.
// Every updater URL must resolve through GitHub's public release-download path.

import { readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const UPDATER_PLATFORMS = Object.freeze({
  "darwin-aarch64": {
    suffix: "aarch64.app.tar.gz",
  },
  "darwin-x86_64": {
    suffix: "x64.app.tar.gz",
  },
  "windows-x86_64": {
    suffix: "x64-setup.exe",
  },
});
export const STABLE_UPDATER_REPOSITORY = "json-choi/dopedb";

const REQUIRED_PLATFORMS = Object.freeze(Object.keys(UPDATER_PLATFORMS));
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertNoMagicKeys(value, label) {
  if (value && typeof value === "object" && Object.keys(value).some((key) => FORBIDDEN_OBJECT_KEYS.has(key))) {
    throw new Error(`${label} contains a forbidden object key`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function normalizeAssets(value) {
  const assets = Array.isArray(value) ? value : value?.assets;
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error("release assets must be a non-empty array");
  }
  return assets;
}

function indexAssets(assets) {
  const byApiUrl = new Map();
  const byDownloadUrl = new Map();
  const byName = new Map();

  for (const asset of assets) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      throw new Error("release asset must be an object");
    }
    assertNoMagicKeys(asset, "release asset");
    assertNonEmptyString(hasOwn(asset, "name") ? asset.name : undefined, "asset.name");
    assertNonEmptyString(hasOwn(asset, "apiUrl") ? asset.apiUrl : undefined, `asset ${asset.name} apiUrl`);
    assertNonEmptyString(hasOwn(asset, "url") ? asset.url : undefined, `asset ${asset.name} url`);

    if (
      byApiUrl.has(asset.apiUrl) ||
      byDownloadUrl.has(asset.url) ||
      byName.has(asset.name)
    ) {
      throw new Error(`duplicate release asset URL for ${asset.name}`);
    }
    byApiUrl.set(asset.apiUrl, asset);
    byDownloadUrl.set(asset.url, asset);
    byName.set(asset.name, asset);
  }

  return { byApiUrl, byDownloadUrl, byName };
}

export function canonicalUpdaterAssetName(version, suffix) {
  return `DopeDB_${version}_${suffix}`;
}

export function canonicalUpdaterUrl(repository, tag, assetName) {
  return `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
}

function assertPublicDownloadUrl(url, repository, tag, assetName) {
  const expectedPrefix = `https://github.com/${repository}/releases/download/${tag}/`;
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !url.startsWith(expectedPrefix)
  ) {
    throw new Error(
      `updater asset ${assetName} must use the public ${expectedPrefix} path`,
    );
  }

  const actualName = decodeURIComponent(parsed.pathname.split("/").at(-1) ?? "");
  if (actualName !== assetName) {
    throw new Error(
      `updater URL filename ${actualName} does not match release asset ${assetName}`,
    );
  }
}

function assertDownloadableAsset(asset, label) {
  if (!hasOwn(asset, "size") || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`${label} must have a positive safe release asset size`);
  }
  const contentType = hasOwn(asset, "contentType") ? asset.contentType?.toLowerCase() : undefined;
  if (
    typeof contentType !== "string" ||
    contentType.length === 0 ||
    contentType.includes("application/json") ||
    contentType.includes("text/html")
  ) {
    throw new Error(`${label} has an invalid release asset content type`);
  }
}

export function assertSha256Digest(asset, label) {
  const digest = hasOwn(asset, "digest") ? asset.digest : undefined;
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${label} must have a strict sha256 asset digest`);
  }
  return digest;
}

function expectedUpdaterAssetNames(version) {
  return new Set(
    REQUIRED_PLATFORMS.flatMap((platform) => {
      const name = canonicalUpdaterAssetName(version, UPDATER_PLATFORMS[platform].suffix);
      return [name, `${name}.sig`];
    }),
  );
}

function looksLikeUpdaterAsset(name) {
  return name.startsWith("DopeDB_") && (
    name.endsWith(".app.tar.gz") ||
    name.endsWith(".app.tar.gz.sig") ||
    name.endsWith("-setup.exe") ||
    name.endsWith("-setup.exe.sig")
  );
}

function allowedNonUpdaterAsset(name, version) {
  return new Set([
    "latest.json",
    "DopeDB-windows-x64-setup.exe",
    "DopeDB-macos-arm64.dmg",
    "DopeDB-macos-x64.dmg",
    `DopeDB_${version}_aarch64.dmg`,
    `DopeDB_${version}_x64.dmg`,
  ]).has(name);
}

function assertExactReleaseClosure(assets, version, repository, tag) {
  const expected = expectedUpdaterAssetNames(version);
  const names = new Set();
  const urls = new Set();
  for (const asset of assets) {
    if (!names.add(asset.name) || !urls.add(asset.url)) {
      throw new Error(`duplicate release asset name or URL for ${asset.name}`);
    }
    if (looksLikeUpdaterAsset(asset.name) && !expected.has(asset.name)) {
      throw new Error(`release contains stale or unsupported updater asset ${asset.name}`);
    }
    if (!expected.has(asset.name) && !allowedNonUpdaterAsset(asset.name, version)) {
      throw new Error(`release asset is outside the stable allowlist: ${asset.name}`);
    }
    if (expected.has(asset.name) || asset.name === "latest.json") {
      assertDownloadableAsset(asset, `release asset ${asset.name}`);
      assertSha256Digest(asset, `release asset ${asset.name}`);
      if (asset.url !== canonicalUpdaterUrl(repository, tag, asset.name)) {
        throw new Error(`release asset ${asset.name} must use its canonical public URL`);
      }
    }
  }
  for (const name of expected) {
    const asset = assets.find((candidate) => candidate.name === name);
    if (!asset || asset.url !== canonicalUpdaterUrl(repository, tag, name)) {
      throw new Error(`release is missing canonical updater closure asset ${name}`);
    }
  }
}

function canonicalPlatforms(platforms) {
  assertNoMagicKeys(platforms, "updater platforms");
  const allowed = new Set(REQUIRED_PLATFORMS);
  for (const platform of Object.keys(platforms)) {
    if (!allowed.has(platform)) {
      throw new Error(`updater manifest has unsupported platform ${platform}`);
    }
  }
  const canonical = {};
  for (const platform of REQUIRED_PLATFORMS) {
    const entry = hasOwn(platforms, platform) ? platforms[platform] : undefined;
    if (!entry) throw new Error(`updater manifest is missing required platform ${platform}`);
    canonical[platform] = entry;
  }
  return canonical;
}

export function finalizeUpdaterManifest({
  manifest,
  releaseAssets,
  repository,
  tag,
}) {
  assertNonEmptyString(repository, "repository");
  assertNonEmptyString(tag, "tag");
  if (repository !== STABLE_UPDATER_REPOSITORY) {
    throw new Error(`stable updater repository must be ${STABLE_UPDATER_REPOSITORY}`);
  }
  if (!tag.startsWith("app-v")) {
    throw new Error(`stable release tag must start with app-v: ${tag}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("updater manifest must be an object");
  }
  assertNoMagicKeys(manifest, "updater manifest");
  assertNonEmptyString(hasOwn(manifest, "version") ? manifest.version : undefined, "manifest.version");
  if (tag !== `app-v${manifest.version}`) {
    throw new Error(
      `manifest version ${manifest.version} does not match release tag ${tag}`,
    );
  }
  if (
    !hasOwn(manifest, "platforms") ||
    !manifest.platforms ||
    typeof manifest.platforms !== "object" ||
    Array.isArray(manifest.platforms)
  ) {
    throw new Error("manifest.platforms must be an object");
  }

  const assets = normalizeAssets(releaseAssets);
  const { byApiUrl, byDownloadUrl, byName } = indexAssets(assets);
  assertExactReleaseClosure(assets, manifest.version, repository, tag);
  const entries = canonicalPlatforms(manifest.platforms);
  const platforms = {};

  for (const [platform, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`platform ${platform} metadata must be an object`);
    }
    assertNoMagicKeys(entry, `platform ${platform}`);
    assertNonEmptyString(hasOwn(entry, "signature") ? entry.signature : undefined, `platform ${platform} signature`);
    assertNonEmptyString(hasOwn(entry, "url") ? entry.url : undefined, `platform ${platform} url`);

    const asset = byApiUrl.get(entry.url) ?? byDownloadUrl.get(entry.url);
    if (!asset) {
      throw new Error(
        `platform ${platform} references an unknown release asset URL: ${entry.url}`,
      );
    }
    const expectedName = canonicalUpdaterAssetName(
      manifest.version,
      UPDATER_PLATFORMS[platform].suffix,
    );
    if (asset.name !== expectedName) {
      throw new Error(`platform ${platform} must reference ${expectedName}`);
    }
    assertPublicDownloadUrl(asset.url, repository, tag, asset.name);
    assertDownloadableAsset(asset, `platform ${platform} archive`);
    const signatureName = `${expectedName}.sig`;
    const signature = byName.get(signatureName);
    if (!signature) {
      throw new Error(`platform ${platform} is missing archive signature ${signatureName}`);
    }
    assertPublicDownloadUrl(signature.url, repository, tag, signatureName);
    assertDownloadableAsset(signature, `platform ${platform} signature`);
    platforms[platform] = {
      ...entry,
      url: canonicalUpdaterUrl(repository, tag, expectedName),
    };
  }

  return { ...manifest, platforms };
}

export function assertFinalizedLatestAsset({ source, releaseAssets, repository, tag }) {
  const manifest = parseJsonWithoutDuplicateKeys(source.toString("utf8"));
  const finalized = finalizeUpdaterManifest({ manifest, releaseAssets, repository, tag });
  const expected = `${JSON.stringify(finalized, null, 2)}\n`;
  if (source.toString("utf8") !== expected) {
    throw new Error("updater manifest is not finalized deterministically");
  }
  const assets = normalizeAssets(releaseAssets);
  const latest = assets.find((asset) => asset?.name === "latest.json");
  if (!latest) throw new Error("release is missing latest.json asset metadata");
  assertDownloadableAsset(latest, "latest.json");
  const expectedDigest = assertSha256Digest(latest, "latest.json");
  if (source.length !== latest.size || `sha256:${createHash("sha256").update(source).digest("hex")}` !== expectedDigest) {
    throw new Error("latest.json bytes do not match refreshed release metadata");
  }
  return finalized;
}

function parseArguments(argv) {
  const values = new Map();
  let check = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }

  for (const required of ["--manifest", "--assets", "--repository", "--tag"]) {
    if (!values.has(required)) {
      throw new Error(`missing required argument ${required}`);
    }
  }

  return {
    assetsPath: values.get("--assets"),
    check,
    manifestPath: values.get("--manifest"),
    repository: values.get("--repository"),
    tag: values.get("--tag"),
  };
}

export function parseJsonWithoutDuplicateKeys(source) {
  let offset = 0;
  const whitespace = /\s/;

  function skip() {
    while (whitespace.test(source[offset] ?? "")) offset += 1;
  }
  function string() {
    const start = offset;
    if (source[offset] !== '"') throw new Error("expected JSON string");
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") {
        offset += 2;
      } else if (source[offset++] === '"') {
        return JSON.parse(source.slice(start, offset));
      }
    }
    throw new Error("unterminated JSON string");
  }
  function value() {
    skip();
    if (source[offset] === "{") return object();
    if (source[offset] === "[") return array();
    if (source[offset] === '"') return string();
    const start = offset;
    while (offset < source.length && !",]} \t\r\n".includes(source[offset])) offset += 1;
    return JSON.parse(source.slice(start, offset));
  }
  function object() {
    const result = Object.create(null);
    const keys = new Set();
    offset += 1;
    skip();
    if (source[offset] === "}") {
      offset += 1;
      return result;
    }
    while (true) {
      skip();
      const key = string();
      if (FORBIDDEN_OBJECT_KEYS.has(key)) throw new Error(`forbidden JSON key ${key}`);
      if (keys.has(key)) throw new Error(`duplicate JSON key ${key}`);
      keys.add(key);
      skip();
      if (source[offset++] !== ":") throw new Error("expected JSON colon");
      result[key] = value();
      skip();
      if (source[offset] === "}") {
        offset += 1;
        return result;
      }
      if (source[offset++] !== ",") throw new Error("expected JSON comma");
    }
  }
  function array() {
    const result = [];
    offset += 1;
    skip();
    if (source[offset] === "]") {
      offset += 1;
      return result;
    }
    while (true) {
      result.push(value());
      skip();
      if (source[offset] === "]") {
        offset += 1;
        return result;
      }
      if (source[offset++] !== ",") throw new Error("expected JSON comma");
    }
  }

  const parsed = value();
  skip();
  if (offset !== source.length) throw new Error("unexpected trailing JSON content");
  return parsed;
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const source = await readFile(options.manifestPath);
  const manifest = parseJsonWithoutDuplicateKeys(source.toString("utf8"));
  const releaseAssets = JSON.parse(await readFile(options.assetsPath, "utf8"));
  const finalized = finalizeUpdaterManifest({
    manifest,
    releaseAssets,
    repository: options.repository,
    tag: options.tag,
  });
  const output = `${JSON.stringify(finalized, null, 2)}\n`;

  if (options.check) {
    assertFinalizedLatestAsset({ source, releaseAssets, repository: options.repository, tag: options.tag });
    return;
  }

  const temporaryPath = `${options.manifestPath}.tmp`;
  await writeFile(temporaryPath, output, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, options.manifestPath);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
