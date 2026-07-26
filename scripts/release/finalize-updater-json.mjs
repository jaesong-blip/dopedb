// Finalizes Tauri updater metadata before a draft release becomes immutable.
// Every updater URL must resolve through GitHub's public release-download path.

import { readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REQUIRED_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
];

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

  for (const asset of assets) {
    assertNonEmptyString(asset?.name, "asset.name");
    assertNonEmptyString(asset?.apiUrl, `asset ${asset.name} apiUrl`);
    assertNonEmptyString(asset?.url, `asset ${asset.name} url`);

    if (byApiUrl.has(asset.apiUrl) || byDownloadUrl.has(asset.url)) {
      throw new Error(`duplicate release asset URL for ${asset.name}`);
    }
    byApiUrl.set(asset.apiUrl, asset);
    byDownloadUrl.set(asset.url, asset);
  }

  return { byApiUrl, byDownloadUrl };
}

function assertPublicDownloadUrl(url, repository, tag, assetName) {
  const expectedPrefix = `https://github.com/${repository}/releases/download/${tag}/`;
  if (!url.startsWith(expectedPrefix)) {
    throw new Error(
      `updater asset ${assetName} must use the public ${expectedPrefix} path`,
    );
  }

  const parsed = new URL(url);
  const actualName = decodeURIComponent(parsed.pathname.split("/").at(-1) ?? "");
  if (actualName !== assetName) {
    throw new Error(
      `updater URL filename ${actualName} does not match release asset ${assetName}`,
    );
  }
}

export function finalizeUpdaterManifest({
  manifest,
  releaseAssets,
  repository,
  tag,
}) {
  assertNonEmptyString(repository, "repository");
  assertNonEmptyString(tag, "tag");
  if (!tag.startsWith("app-v")) {
    throw new Error(`stable release tag must start with app-v: ${tag}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("updater manifest must be an object");
  }
  assertNonEmptyString(manifest.version, "manifest.version");
  if (tag !== `app-v${manifest.version}`) {
    throw new Error(
      `manifest version ${manifest.version} does not match release tag ${tag}`,
    );
  }
  if (
    !manifest.platforms ||
    typeof manifest.platforms !== "object" ||
    Array.isArray(manifest.platforms)
  ) {
    throw new Error("manifest.platforms must be an object");
  }

  for (const platform of REQUIRED_PLATFORMS) {
    if (!(platform in manifest.platforms)) {
      throw new Error(`updater manifest is missing required platform ${platform}`);
    }
  }

  const assets = normalizeAssets(releaseAssets);
  const { byApiUrl, byDownloadUrl } = indexAssets(assets);
  const platforms = {};

  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`platform ${platform} metadata must be an object`);
    }
    assertNonEmptyString(entry.signature, `platform ${platform} signature`);
    assertNonEmptyString(entry.url, `platform ${platform} url`);

    const asset = byApiUrl.get(entry.url) ?? byDownloadUrl.get(entry.url);
    if (!asset) {
      throw new Error(
        `platform ${platform} references an unknown release asset URL: ${entry.url}`,
      );
    }
    assertPublicDownloadUrl(asset.url, repository, tag, asset.name);
    platforms[platform] = { ...entry, url: asset.url };
  }

  return { ...manifest, platforms };
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

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const source = await readFile(options.manifestPath, "utf8");
  const manifest = JSON.parse(source);
  const releaseAssets = JSON.parse(await readFile(options.assetsPath, "utf8"));
  const finalized = finalizeUpdaterManifest({
    manifest,
    releaseAssets,
    repository: options.repository,
    tag: options.tag,
  });
  const output = `${JSON.stringify(finalized, null, 2)}\n`;

  if (options.check) {
    if (source !== output) {
      throw new Error("updater manifest is not finalized deterministically");
    }
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
