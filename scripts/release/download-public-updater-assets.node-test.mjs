import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalUpdaterAssetName,
  canonicalUpdaterUrl,
  finalizeUpdaterManifest,
} from "./finalize-updater-json.mjs";
import { downloadPublicUpdaterRelease, fetchPublic, retryDelay } from "./download-public-updater-assets.mjs";

const repository = "json-choi/dopedb";
const tag = "app-v0.4.0";
const version = "0.4.0";

function reply(status, url, headers = {}, body = "payload") {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    headers: new Headers(headers),
    ok: status >= 200 && status < 300,
    status,
    url,
  };
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
    const payload = suffix.includes("setup") ? new Uint8Array([77, 90, 1]) : new Uint8Array([31, 139, 1]);
    const signature = new TextEncoder().encode(`signature-${platform}`);
    const url = canonicalUpdaterUrl(repository, tag, name);
    assets.push({ apiUrl: `https://api.github.com/assets/${assets.length}`, contentType: "application/octet-stream", digest: `sha256:${createHash("sha256").update(payload).digest("hex")}`, name, size: payload.length, url, payload });
    const signatureName = `${name}.sig`;
    assets.push({ apiUrl: `https://api.github.com/assets/${assets.length}`, contentType: "application/octet-stream", digest: `sha256:${createHash("sha256").update(signature).digest("hex")}`, name: signatureName, size: signature.length, url: canonicalUpdaterUrl(repository, tag, signatureName), payload: signature });
    platforms[platform] = { signature: Buffer.from(signature).toString("base64"), url };
  }
  const manifest = finalizeUpdaterManifest({
    manifest: { version, notes: "test", platforms },
    releaseAssets: { assets }, repository, tag,
  });
  const source = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  assets.push({
    apiUrl: `https://api.github.com/assets/${assets.length}`,
    contentType: "application/octet-stream",
    digest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    name: "latest.json",
    size: source.length,
    url: canonicalUpdaterUrl(repository, tag, "latest.json"),
    payload: source,
  });
  return { assets: { assets: assets.map(({ payload, ...asset }) => asset) }, manifest, payloads: assets };
}

test("public downloader accepts a public binary response", async () => {
  const result = await fetchPublic(
    async () => reply(200, "https://release-assets.githubusercontent.com/archive", { "content-type": "application/octet-stream" }),
    "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/archive", "archive",
  );
  assert.equal(result.status, 200);
});

test("retries only bounded safe transient failures and respects Retry-After", async () => {
  let attempts = 0;
  const waits = [];
  const response = await fetchPublic(
    async () => {
      attempts += 1;
      return attempts === 1
        ? reply(503, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", { "retry-after": "2" })
        : reply(200, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", { "content-type": "application/octet-stream" });
    },
    "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive",
    { now: () => 0, sleep: async (milliseconds) => waits.push(milliseconds) },
  );
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2_000]);
});

test("parses Retry-After delta seconds and HTTP dates against the injected clock", () => {
  const now = () => Date.parse("2030-01-01T00:00:00Z");
  const options = { maxRetryDelayMs: 5_000, now };
  assert.equal(retryDelay({ headers: new Headers({ "retry-after": "3" }) }, 0, options), 3_000);
  assert.equal(retryDelay({ headers: new Headers({ "retry-after": "Tue, 01 Jan 2030 00:00:04 GMT" }) }, 0, options), 4_000);
  assert.equal(retryDelay({ headers: new Headers({ "retry-after": "12" }) }, 0, options), 12_000);
  assert.equal(retryDelay({ headers: new Headers({ "retry-after": "Tue, 01 Jan 2030 00:00:15 GMT" }) }, 0, options), 15_000);
  assert.equal(retryDelay({ headers: new Headers() }, 8, options), 5_000);
  assert.equal(retryDelay(undefined, 8, options), 5_000);
});

test("uses only strict RFC delay-seconds or IMF-fixdate Retry-After values", () => {
  const now = () => Date.parse("2030-01-01T00:00:00Z");
  const options = { maxRetryDelayMs: 5_000, now };
  for (const invalid of ["1.5", "+2", "0x10", "1e3", "", "not-a-date", "Tue, 1 Jan 2030 00:00:04 GMT"]) {
    assert.equal(
      retryDelay({ headers: new Headers({ "retry-after": invalid }) }, 0, options),
      250,
      `invalid Retry-After ${JSON.stringify(invalid)} must use local fallback`,
    );
  }
  assert.equal(retryDelay({ headers: new Headers({ "retry-after": "0002" }) }, 0, options), 2_000);
  assert.equal(retryDelay({ headers: new Headers({ "retry-after": "0" }) }, 0, options), 0);
  assert.equal(
    retryDelay({ headers: new Headers({ "retry-after": "999999999999999999999999999999" }) }, 0, options),
    Number.POSITIVE_INFINITY,
  );
});

test("honors server retry delays above local backoff and refuses a delay beyond the global deadline", async () => {
  const waits = [];
  let calls = 0;
  await fetchPublic(
    async () => {
      calls += 1;
      return calls === 1
        ? reply(503, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", { "retry-after": "12" })
        : reply(200, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", { "content-type": "application/octet-stream" });
    },
    "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive",
    { maxRetryDelayMs: 5_000, now: () => 0, sleep: async (milliseconds) => waits.push(milliseconds), totalTimeoutMs: 13_000 },
  );
  assert.deepEqual(waits, [12_000]);
  for (const retryAfter of ["8", "Thu, 01 Jan 1970 00:00:08 GMT"]) {
    await assert.rejects(
      fetchPublic(
        async () => reply(503, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", { "retry-after": retryAfter }),
        "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive",
        { now: () => 0, sleep: async () => assert.fail("must not sleep beyond deadline"), totalTimeoutMs: 7_000 },
      ),
      /retry delay exceeds the remaining public verification deadline/,
    );
  }
});

test("honors valid Retry-After before redirects and fails huge directives at the shared deadline", async () => {
  const waits = [];
  let calls = 0;
  const response = await fetchPublic(
    async () => {
      calls += 1;
      return calls === 1
        ? reply(302, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", {
          location: "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/b",
          "retry-after": "0002",
        })
        : reply(200, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/b", { "content-type": "application/octet-stream" });
    },
    "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive",
    { now: () => 0, sleep: async (milliseconds) => waits.push(milliseconds), totalTimeoutMs: 3_000 },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(waits, [2_000]);
  let invalidRedirectCalls = 0;
  const invalidRedirect = await fetchPublic(
    async () => {
      invalidRedirectCalls += 1;
      return invalidRedirectCalls === 1
        ? reply(302, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", {
          location: "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/b",
          "retry-after": "1.5",
        })
        : reply(200, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/b", { "content-type": "application/octet-stream" });
    },
    "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive",
    { now: () => 0, sleep: async () => assert.fail("invalid redirect Retry-After must not delay"), totalTimeoutMs: 3_000 },
  );
  assert.equal(invalidRedirect.status, 200);
  await assert.rejects(
    fetchPublic(
      async () => reply(302, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", {
        location: "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/b",
        "retry-after": "999999999999999999999999999999",
      }),
      "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive",
      { now: () => 0, sleep: async () => assert.fail("must not sleep beyond deadline") },
    ),
    /retry delay exceeds the remaining public verification deadline/,
  );
});

test("auth, API, HTML, and timeout failures are never accepted", async () => {
  await assert.rejects(
    fetchPublic(async () => reply(401, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", { "content-type": "application/octet-stream" }), "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive"),
    /HTTP 401/,
  );
  await assert.rejects(
    fetchPublic(async () => reply(200, "https://api.github.com/assets/1", { "content-type": "application/octet-stream" }), "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive"),
    /non-public/,
  );
  await assert.rejects(
    fetchPublic(async () => reply(200, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", { "content-type": "text/html" }), "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive"),
    /content type/,
  );
  let attempts = 0;
  await assert.rejects(
    fetchPublic(async () => { attempts += 1; throw new DOMException("timeout", "TimeoutError"); }, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive", { maxAttempts: 2, now: () => 0, sleep: async () => {} }),
    /bounded public retry deadline/,
  );
  assert.equal(attempts, 2);
});

test("rejects credential-bearing public URLs before any request", async () => {
  await assert.rejects(
    fetchPublic(
      async () => assert.fail("credential-bearing URL must not reach fetch"),
      "https://user:password@github.com/json-choi/dopedb/releases/download/app-v0.4.0/a",
      "archive",
    ),
    /non-public/,
  );
});

test("rejects arbitrary HTTPS redirect targets and bounded redirect loops separately from retries", async () => {
  await assert.rejects(
    fetchPublic(async () => reply(302, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", { location: "https://example.com/archive" }), "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive"),
    /non-public/,
  );
  let redirects = 0;
  await assert.rejects(
    fetchPublic(async () => { redirects += 1; return reply(302, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", { location: "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a" }); }, "https://github.com/json-choi/dopedb/releases/download/app-v0.4.0/a", "archive", { maxAttempts: 1, maxRedirects: 2 }),
    /redirect limit/,
  );
  assert.equal(redirects, 3);
});

test("streams the canonical closure and removes partial output on size or signature failure", async () => {
  const source = fixture();
  const root = await mkdtemp(path.join(tmpdir(), "dopedb-release-test-"));
  const output = path.join(root, "public-assets");
  const latestUrl = "https://github.com/json-choi/dopedb/releases/latest/download/latest.json";
  const body = `${JSON.stringify(source.manifest, null, 2)}\n`;
  try {
    await assert.rejects(
      downloadPublicUpdaterRelease({
        assets: source.assets, latestUrl, output, repository, tag,
        fetchImpl: async (url) => {
          const urlText = String(url);
          if (urlText.includes("latest/download/latest.json")) return reply(200, urlText, { "content-length": String(Buffer.byteLength(body)), "content-type": "application/octet-stream" }, body);
          const asset = source.payloads.find((candidate) => candidate.url === urlText);
          const oversized = asset.name.endsWith("aarch64.app.tar.gz") ? new Uint8Array([...asset.payload, 9]) : asset.payload;
          return reply(200, urlText, { "content-length": String(asset.payload.length), "content-type": "application/octet-stream" }, oversized);
        },
      }),
      /exceeded its declared size/,
    );
    assert.equal((await readdir(root)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects incorrect Content-Length and a public signature mismatch without leaving output", async () => {
  const source = fixture();
  const root = await mkdtemp(path.join(tmpdir(), "dopedb-release-test-"));
  const latestUrl = "https://github.com/json-choi/dopedb/releases/latest/download/latest.json";
  const body = `${JSON.stringify(source.manifest, null, 2)}\n`;
  const run = async (name, mode, expected) => {
    const output = path.join(root, name);
    await assert.rejects(
      downloadPublicUpdaterRelease({
        assets: source.assets, latestUrl, output, repository, tag,
        fetchImpl: async (url) => {
          const urlText = String(url);
          if (urlText.includes("latest/download/latest.json")) return reply(200, urlText, { "content-length": String(Buffer.byteLength(body)), "content-type": "application/octet-stream" }, body);
          const asset = source.payloads.find((candidate) => candidate.url === urlText);
          const payload = mode === "signature" && asset.name.endsWith(".sig")
            ? new Uint8Array(asset.payload.map((byte) => byte ^ 1)) : asset.payload;
          const size = mode === "length" && asset.name.endsWith("aarch64.app.tar.gz") ? asset.payload.length + 1 : asset.payload.length;
          return reply(200, urlText, { "content-length": String(size), "content-type": "application/octet-stream" }, payload);
        },
      }), expected,
    );
    assert.equal((await readdir(root)).includes(name), false);
  };
  try {
    await run("bad-length", "length", /invalid Content-Length/);
    await run("bad-signature", "signature", /signature SHA-256 does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
