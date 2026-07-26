// Downloads the immutable public updater closure without credentials or full-memory installers.

import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  UPDATER_PLATFORMS,
  canonicalUpdaterAssetName,
  canonicalUpdaterUrl,
  assertSha256Digest,
  finalizeUpdaterManifest,
  parseJsonWithoutDuplicateKeys,
} from "./finalize-updater-json.mjs";

const DEFAULTS = Object.freeze({
  maxArchiveBytes: 4 * 1024 * 1024 * 1024,
  maxLatestBytes: 512 * 1024,
  maxSignatureBytes: 64 * 1024,
  maxAttempts: 4,
  maxRedirects: 8,
  maxRetryDelayMs: 5_000,
  perRequestTimeoutMs: 15_000,
  totalTimeoutMs: 120_000,
});
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function fail(message) {
  throw new Error(message);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} is required`);
  return value;
}

const PUBLIC_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function safePublicLocation(url, label) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    !PUBLIC_HOSTS.has(host) ||
    parsed.username ||
    parsed.password ||
    host.startsWith("auth.") ||
    host.startsWith("login.") ||
    (host === "github.com" && (!/^\/json-choi\/dopedb\/releases\/(?:latest\/download\/latest\.json|download\/app-v[^/]+\/[^/]+)$/.test(parsed.pathname)
      || /^\/(?:login|session|sessions|sso)(?:\/|$)/.test(parsed.pathname)))
  ) {
    fail(`${label} redirected to an authenticated or non-public location`);
  }
  return parsed;
}

function serverRetryAfter(response, options) {
  const retryAfter = response?.headers?.get("retry-after");
  if (typeof retryAfter !== "string") return undefined;

  // RFC 9110 delay-seconds is one-or-more decimal digits. Deliberately do
  // not coerce JavaScript number spellings such as `1e3`, `+2`, or `0x10`.
  if (/^\d+$/.test(retryAfter)) {
    const normalized = retryAfter.replace(/^0+/, "") || "0";
    const maximumSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
    // Preserve a syntactically valid directive that cannot fit in JavaScript
    // milliseconds. Infinity makes the shared-deadline gate fail closed
    // instead of silently treating the server directive as malformed.
    if (normalized.length > String(maximumSeconds).length || Number(normalized) > maximumSeconds) {
      return Number.POSITIVE_INFINITY;
    }
    return Number(normalized) * 1_000;
  }

  // Accept only an IMF-fixdate HTTP-date, rather than Date.parse's broader
  // set of implementation-specific date strings. Invalid directives fall
  // back to the bounded local exponential retry policy.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter)) {
    return undefined;
  }
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) && new Date(date).toUTCString() === retryAfter
    ? Math.max(0, date - (options.now ?? Date.now)())
    : undefined;
}

export function retryDelay(response, attempt, options) {
  // A server Retry-After is an operational directive, not a local backoff
  // preference: clipping it would retry before GitHub has asked us to.
  return serverRetryAfter(response, options)
    ?? Math.min(250 * 2 ** attempt, options.maxRetryDelayMs);
}

async function waitForRetry(delay, serverDirected, deadline, now, sleep, label) {
  const remaining = deadline - now();
  if (remaining <= 0 || (serverDirected && delay > remaining)) {
    fail(`${label} retry delay exceeds the remaining public verification deadline`);
  }
  await sleep(Math.min(delay, remaining));
}

function transient(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError" || error instanceof TypeError;
}

async function closeResponse(response) {
  await response?.body?.cancel?.().catch(() => {});
}

export async function fetchPublic(fetchImpl, url, label, overrides = {}) {
  const options = { ...DEFAULTS, ...overrides };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = options.deadline ?? now() + options.totalTimeoutMs;
  let current = new URL(url);
  let attempts = 0;
  let redirects = 0;
  for (;;) {
    if (now() >= deadline) {
      fail(`${label} exceeded its bounded public retry deadline`);
    }
    safePublicLocation(current, label);
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(options.perRequestTimeoutMs, Math.max(1, deadline - now()))),
      });
    } catch (error) {
      if (!transient(error)) throw error;
      attempts += 1;
      if (attempts >= options.maxAttempts) fail(`${label} exceeded its bounded public retry deadline`);
      await waitForRetry(retryDelay(undefined, attempts, options), false, deadline, now, sleep, label);
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const serverDelay = serverRetryAfter(response, options);
      await closeResponse(response);
      if (!location) fail(`${label} returned a redirect without a location`);
      redirects += 1;
      if (redirects > options.maxRedirects) fail(`${label} exceeded its bounded redirect limit`);
      if (serverDelay !== undefined) {
        await waitForRetry(serverDelay, true, deadline, now, sleep, label);
      }
      current = new URL(location, current);
      continue;
    }
    if (RETRYABLE_STATUSES.has(response.status)) {
      const serverDelay = serverRetryAfter(response, options);
      const delay = retryDelay(response, attempts, options);
      await closeResponse(response);
      attempts += 1;
      if (attempts >= options.maxAttempts) fail(`${label} exceeded its bounded public retry deadline`);
      await waitForRetry(delay, serverDelay !== undefined, deadline, now, sleep, label);
      continue;
    }
    if (!response.ok) {
      await closeResponse(response);
      fail(`${label} returned HTTP ${response.status}`);
    }
    safePublicLocation(response.url || current, label);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType || contentType.includes("text/html")) {
      await closeResponse(response);
      fail(`${label} returned an invalid content type ${contentType || "<absent>"}`);
    }
    return response;
  }
}

function contentLength(response, expected, maximum, label) {
  const raw = response.headers.get("content-length");
  const length = Number(raw);
  if (!/^\d+$/.test(raw ?? "") || !Number.isSafeInteger(length) || length < 0 || length !== expected || length > maximum) {
    fail(`${label} has an invalid Content-Length`);
  }
}

async function streamToFile(response, destination, expected, digest, maximum, label) {
  contentLength(response, expected, maximum, label);
  const temporary = `${destination}.partial-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    const reader = response.body?.getReader?.();
    if (!reader) fail(`${label} has no readable response body`);
    let written = 0;
    const hash = createHash("sha256");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maximum || written > expected) fail(`${label} exceeded its declared size`);
      hash.update(value);
      await handle.write(value);
    }
    if (written !== expected) fail(`${label} byte count does not match release metadata`);
    if (`sha256:${hash.digest("hex")}` !== digest) fail(`${label} SHA-256 does not match release metadata`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    await closeResponse(response);
  }
}

async function boundedText(response, expected, digest, maximum, label) {
  const raw = response.headers.get("content-length");
  if (!/^\d+$/.test(raw ?? "") || !Number.isSafeInteger(Number(raw)) || Number(raw) !== expected || expected > maximum) {
    fail(`${label} exceeds its maximum size`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail(`${label} has no readable response body`);
  const chunks = [];
  let length = 0;
  const hash = createHash("sha256");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) fail(`${label} exceeds its maximum size`);
      hash.update(value);
      chunks.push(value);
    }
    if (length !== expected || `sha256:${hash.digest("hex")}` !== digest) fail(`${label} bytes do not match release metadata`);
    return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } finally {
    await closeResponse(response);
  }
}

function assetsByUrl(releaseAssets) {
  const values = Array.isArray(releaseAssets) ? releaseAssets : releaseAssets?.assets;
  if (!Array.isArray(values)) fail("release assets must contain an assets array");
  const assets = new Map();
  for (const asset of values) {
    if (!asset?.name || !asset?.url || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      fail("release asset is missing name, public URL, or safe size");
    }
    if (assets.has(asset.url)) fail(`duplicate release asset URL ${asset.url}`);
    assets.set(asset.url, asset);
  }
  return assets;
}

async function readSmallFile(file, maximum, label) {
  const bytes = await readFile(file);
  if (bytes.length > maximum) fail(`${label} exceeds its maximum size`);
  return bytes;
}

export async function downloadPublicUpdaterRelease({
  assets,
  fetchImpl = fetch,
  latestUrl,
  output,
  repository,
  tag,
  transport,
}) {
  const options = { ...DEFAULTS, ...transport };
  const now = options.now ?? Date.now;
  options.deadline ??= now() + options.totalTimeoutMs;
  const stage = `${output}.partial-${randomUUID()}`;
  try {
    await mkdir(stage, { recursive: true, mode: 0o700 });
    const releaseAssets = assetsByUrl(assets);
    const latestAsset = releaseAssets.get(canonicalUpdaterUrl(repository, tag, "latest.json"));
    if (!latestAsset || latestAsset.name !== "latest.json") fail("latest.json is missing from refreshed release metadata");
    const latest = await fetchPublic(fetchImpl, latestUrl, "public updater metadata", options);
    const source = await boundedText(latest, latestAsset.size, assertSha256Digest(latestAsset, "latest.json"), options.maxLatestBytes, "public updater metadata");
    const manifest = parseJsonWithoutDuplicateKeys(source);
    const finalized = finalizeUpdaterManifest({ manifest, releaseAssets: assets, repository, tag });
    if (source !== `${JSON.stringify(finalized, null, 2)}\n`) {
      fail("public updater metadata is not canonical/finalized");
    }
    await writeFile(path.join(stage, "latest.json"), source, { mode: 0o600 });
    for (const [platform, spec] of Object.entries(UPDATER_PLATFORMS)) {
      const name = canonicalUpdaterAssetName(finalized.version, spec.suffix);
      const url = canonicalUpdaterUrl(repository, tag, name);
      const asset = releaseAssets.get(url);
      if (!asset || asset.name !== name) fail(`${platform} archive is missing from release metadata`);
      const archive = await fetchPublic(fetchImpl, url, `${platform} updater archive`, options);
      if (archive.headers.get("content-type")?.toLowerCase().includes("json")) {
        await closeResponse(archive);
        fail(`${platform} updater archive returned JSON`);
      }
      await streamToFile(archive, path.join(stage, name), asset.size, assertSha256Digest(asset, `${platform} archive`), options.maxArchiveBytes, `${platform} updater archive`);

      const signatureName = `${name}.sig`;
      const signatureUrl = canonicalUpdaterUrl(repository, tag, signatureName);
      const signatureAsset = releaseAssets.get(signatureUrl);
      if (!signatureAsset || signatureAsset.name !== signatureName) fail(`${platform} updater signature is missing from release metadata`);
      const signature = await fetchPublic(fetchImpl, signatureUrl, `${platform} updater signature`, options);
      await streamToFile(signature, path.join(stage, signatureName), signatureAsset.size, assertSha256Digest(signatureAsset, `${platform} signature`), options.maxSignatureBytes, `${platform} updater signature`);
      const expected = Buffer.from(finalized.platforms[platform].signature, "base64");
      const actual = await readSmallFile(path.join(stage, signatureName), options.maxSignatureBytes, `${platform} updater signature`);
      if (!expected.equals(actual)) fail(`${platform} manifest signature does not match the public signature asset`);
    }
    await rename(stage, output);
    return finalized;
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function argumentsFor(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name)) fail(`invalid argument ${name ?? "<missing>"}`);
    values.set(name, value);
  }
  return Object.fromEntries(["assets", "latest-url", "output", "repository", "tag"].map((name) => [name, requiredString(values.get(`--${name}`), `--${name}`)]));
}

async function runCli() {
  const options = argumentsFor(process.argv.slice(2));
  await downloadPublicUpdaterRelease({
    assets: parseJsonWithoutDuplicateKeys(await readFile(options.assets, "utf8")),
    latestUrl: options["latest-url"], output: options.output, repository: options.repository, tag: options.tag,
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
