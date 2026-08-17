// Read-only GitHub App boundary for Project Knowledge. Installation tokens are
// minted per request, kept in function-local memory, and never returned or stored.
import "server-only";

import {
  createHash,
  createHmac,
  createSign,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../env";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const MAX_REPOSITORIES = 1_000;
const MAX_SOURCE_FILES = 100_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 8_000;
const GITHUB_METADATA_RESPONSE_BYTES = 1024 * 1024;
const GITHUB_TREE_RESPONSE_BYTES = 8 * 1024 * 1024;
const GITHUB_BLOB_RESPONSE_BYTES = 24 * 1024 * 1024;

type GithubInstallationToken = {
  token: string;
  expires_at: string;
};

export class GithubKnowledgeRequestError extends Error {
  constructor(readonly status: number) {
    super("GitHub Knowledge request failed");
    this.name = "GithubKnowledgeRequestError";
  }
}

export type GithubInstallation = {
  id: number;
  account: { id: number; login: string };
  repository_selection: "all" | "selected";
  suspended_at: string | null;
};

export type GithubRepository = {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
};

export type GithubSourceFile = {
  path: string;
  blobSha: string;
  bytes: number;
};

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function githubAppConfiguration() {
  const appId = env.githubKnowledgeAppId();
  const appSlug = env.githubKnowledgeAppSlug();
  const privateKey = env.githubKnowledgePrivateKey();
  if (
    !appId
    || !/^[1-9][0-9]{0,19}$/.test(appId)
    || !appSlug
    || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(appSlug)
    || !privateKey
  ) {
    throw new Error("GitHub Knowledge App is not configured");
  }
  return { appId, appSlug, privateKey };
}

export function githubKnowledgeConfigured() {
  try {
    githubAppConfiguration();
    const webhookSecret = env.githubKnowledgeWebhookSecret();
    return Boolean(webhookSecret && webhookSecret.length >= 32);
  } catch {
    return false;
  }
}

export function githubInstallationUrl(state: string) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(state)) {
    throw new Error("Invalid GitHub installation state");
  }
  const { appSlug } = githubAppConfiguration();
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

function appJwt() {
  const { appId, privateKey } = githubAppConfiguration();
  const now = Math.floor(Date.now() / 1_000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  }));
  const input = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(privateKey).toString("base64url")}`;
}

async function githubJson<T>(
  path: string,
  authorization: string,
  init: RequestInit = {},
  maximumBytes = GITHUB_METADATA_RESPONSE_BYTES,
): Promise<T> {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error("Invalid GitHub API path");
  }
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authorization}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "DopeDB-Project-Knowledge",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new GithubKnowledgeRequestError(response.status);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new Error("GitHub returned a non-JSON response");
  }
  const declaredLengthHeader = response.headers.get("content-length");
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  if (declaredLength !== null && (
    !Number.isSafeInteger(declaredLength)
    || declaredLength < 0
    || declaredLength > maximumBytes
  )) {
    throw new Error("GitHub response exceeded the configured byte limit");
  }
  if (!response.body) throw new Error("GitHub returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("GitHub response exceeded the configured byte limit");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("GitHub returned invalid UTF-8 JSON");
  }
  return JSON.parse(text) as T;
}

export async function inspectGithubInstallation(installationId: bigint) {
  if (installationId <= 0n || installationId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid GitHub installation id");
  }
  return await githubJson<GithubInstallation>(
    `/app/installations/${installationId.toString()}`,
    appJwt(),
  );
}

async function installationToken(installationId: bigint) {
  const token = await githubJson<GithubInstallationToken>(
    `/app/installations/${installationId.toString()}/access_tokens`,
    appJwt(),
    {
      method: "POST",
      body: JSON.stringify({ permissions: { contents: "read" } }),
    },
  );
  if (
    typeof token.token !== "string"
    || token.token.length < 20
    || !Number.isFinite(Date.parse(token.expires_at))
  ) {
    throw new Error("GitHub returned an invalid installation token");
  }
  return token.token;
}

export async function listGithubRepositories(installationId: bigint) {
  const token = await installationToken(installationId);
  const repositories: GithubRepository[] = [];
  for (let page = 1; repositories.length < MAX_REPOSITORIES; page += 1) {
    const response = await githubJson<{
      total_count: number;
      repositories: GithubRepository[];
    }>(`/installation/repositories?per_page=100&page=${page}`, token);
    if (!Number.isSafeInteger(response.total_count) || response.total_count < 0) {
      throw new Error("GitHub returned an invalid repository inventory size");
    }
    if (response.total_count > MAX_REPOSITORIES) {
      throw new Error("GitHub installation exceeds the repository inventory limit");
    }
    if (!Array.isArray(response.repositories) || response.repositories.length > 100) {
      throw new Error("GitHub returned an invalid repository inventory");
    }
    for (const repository of response.repositories) {
      if (
        repository !== null
        && typeof repository === "object"
        && Number.isSafeInteger(repository.id)
        && repository.id > 0
        && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.full_name)
        && /^[A-Za-z0-9._\/-]{1,255}$/.test(repository.default_branch)
      ) {
        if (repositories.length >= MAX_REPOSITORIES) {
          throw new Error("GitHub installation exceeds the repository inventory limit");
        }
        repositories.push(repository);
      }
    }
    if (response.repositories.length < 100 || repositories.length >= response.total_count) break;
  }
  return repositories.sort((left, right) => left.full_name.localeCompare(right.full_name));
}

function checkedRepository(repository: string) {
  const segments = repository.split("/");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Invalid GitHub repository identity");
  }
  return repository;
}

function checkedRef(refName: string) {
  if (
    !/^[A-Za-z0-9._\/-]{1,255}$/.test(refName)
    || refName.startsWith("/")
    || refName.startsWith(".")
    || refName.endsWith("/")
    || refName.endsWith(".")
    || refName.includes("..")
    || refName.includes("//")
  ) {
    throw new Error("Invalid GitHub ref");
  }
  return refName;
}

export async function resolveGithubCommit(
  installationId: bigint,
  repository: string,
  refName: string,
) {
  const token = await installationToken(installationId);
  const commit = await githubJson<{ sha: string }>(
    `/repos/${checkedRepository(repository)}/commits/${encodeURIComponent(checkedRef(refName))}`,
    token,
  );
  if (!/^[0-9a-f]{40}$/.test(commit.sha)) {
    throw new Error("GitHub returned an invalid commit identity");
  }
  return commit.sha;
}

const SOURCE_EXTENSIONS = new Set([
  "c", "cc", "cjs", "cpp", "cs", "go", "h", "hpp", "java", "js", "json", "jsx",
  "kt", "kts", "md", "mdx", "mjs", "php", "proto", "py", "rb", "rs", "sh", "sql",
  "svelte", "swift", "toml", "ts", "tsx", "vue", "yaml", "yml",
]);
const EXCLUDED_SEGMENTS = new Set([
  ".git", ".next", "build", "dist", "node_modules", "target", "vendor",
]);

function supportedSourcePath(path: string) {
  const segments = path.split("/");
  const fileName = segments.at(-1)?.toLowerCase();
  const extension = fileName?.split(".").at(-1);
  return Boolean(
    fileName
    && (fileName === "dockerfile"
      || fileName.startsWith("dockerfile.")
      || (extension && SOURCE_EXTENSIONS.has(extension)))
    && segments.every((segment) => segment && segment !== "." && segment !== "..")
    && !/[\u0000-\u001f\u007f-\u009f]/.test(path)
    && !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment)),
  );
}

export async function githubSourceManifest(
  installationId: bigint,
  repository: string,
  commitSha: string,
  options: { maxTotalBytes?: number } = {},
) {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Invalid GitHub commit");
  const token = await installationToken(installationId);
  const tree = await githubJson<{
    truncated: boolean;
    tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>;
  }>(
    `/repos/${checkedRepository(repository)}/git/trees/${commitSha}?recursive=1`,
    token,
    {},
    GITHUB_TREE_RESPONSE_BYTES,
  );
  if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > MAX_SOURCE_FILES) {
    throw new Error("GitHub repository tree is truncated or invalid");
  }
  const maxTotalBytes = options.maxTotalBytes ?? MAX_SOURCE_BYTES;
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
    throw new Error("Invalid GitHub source manifest budget");
  }
  let totalBytes = 0;
  const files: GithubSourceFile[] = [];
  for (const item of tree.tree) {
    if (
      item.type !== "blob"
      || item.mode === "120000"
      || !supportedSourcePath(item.path)
      || !Number.isSafeInteger(item.size)
      || (item.size ?? 0) < 0
      || (item.size ?? 0) > MAX_SOURCE_FILE_BYTES
      || !/^[0-9a-f]{40}$/.test(item.sha)
    ) {
      continue;
    }
    totalBytes += item.size ?? 0;
    if (files.length >= MAX_SOURCE_FILES || totalBytes > maxTotalBytes) {
      throw new Error("GitHub repository exceeds the code-index manifest budget");
    }
    files.push({ path: item.path, blobSha: item.sha, bytes: item.size ?? 0 });
  }
  return files.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"))
  );
}

async function readGithubBlobWithToken(
  token: string,
  repository: string,
  blobSha: string,
) {
  if (!/^[0-9a-f]{40}$/.test(blobSha)) throw new Error("Invalid GitHub blob identity");
  const blob = await githubJson<{ encoding: string; content: string; size: number }>(
    `/repos/${checkedRepository(repository)}/git/blobs/${blobSha}`,
    token,
    {},
    GITHUB_BLOB_RESPONSE_BYTES,
  );
  if (
    blob.encoding !== "base64"
    || !Number.isSafeInteger(blob.size)
    || blob.size < 0
    || blob.size > MAX_SOURCE_FILE_BYTES
  ) {
    throw new Error("GitHub returned an invalid source blob");
  }
  const bytes = Buffer.from(blob.content.replaceAll("\n", ""), "base64");
  if (bytes.byteLength !== blob.size) throw new Error("GitHub source blob size changed");
  const identity = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  if (identity !== blobSha) throw new Error("GitHub source blob identity changed");
  return bytes;
}

export async function readGithubBlobs(
  installationId: bigint,
  repository: string,
  files: ReadonlyArray<{ path: string; blobSha: string }>,
) {
  if (files.length < 1 || files.length > 50) throw new Error("Invalid GitHub blob batch");
  const token = await installationToken(installationId);
  const results = new Array<{ path: string; bytes: Buffer }>(files.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      const file = files[index]!;
      results[index] = {
        path: file.path,
        bytes: await readGithubBlobWithToken(token, repository, file.blobSha),
      };
    }
  }));
  return results;
}

export function verifyGithubWebhook(rawBody: Buffer, signature: string | null) {
  const secret = env.githubKnowledgeWebhookSecret();
  if (!secret || secret.length < 32 || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const receivedBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return receivedBytes.length === expectedBytes.length
    && timingSafeEqual(receivedBytes, expectedBytes);
}
