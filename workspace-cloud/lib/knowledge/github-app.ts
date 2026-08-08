// Read-only GitHub App boundary for Project Knowledge. Installation tokens are
// minted per request, kept in function-local memory, and never returned or stored.
import "server-only";

import {
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

type GithubInstallationToken = {
  token: string;
  expires_at: string;
};

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
): Promise<T> {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error("Invalid GitHub API path");
  }
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
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
    throw new Error(`GitHub request failed with status ${response.status}`);
  }
  return await response.json() as T;
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
    for (const repository of response.repositories) {
      if (
        Number.isSafeInteger(repository.id)
        && repository.id > 0
        && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.full_name)
        && /^[A-Za-z0-9._\/-]{1,255}$/.test(repository.default_branch)
      ) {
        repositories.push(repository);
      }
    }
    if (response.repositories.length < 100 || repositories.length >= response.total_count) break;
  }
  if (repositories.length > MAX_REPOSITORIES) {
    throw new Error("GitHub installation exceeds the repository inventory limit");
  }
  return repositories.sort((left, right) => left.full_name.localeCompare(right.full_name));
}

function checkedRepository(repository: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
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
  "kt", "kts", "mjs", "php", "py", "rb", "rs", "sql", "svelte", "swift", "toml",
  "ts", "tsx", "vue", "yaml", "yml",
]);
const EXCLUDED_SEGMENTS = new Set([
  ".git", ".next", "build", "dist", "node_modules", "target", "vendor",
]);

function supportedSourcePath(path: string) {
  const segments = path.split("/");
  const extension = segments.at(-1)?.split(".").at(-1)?.toLowerCase();
  return Boolean(
    extension
    && SOURCE_EXTENSIONS.has(extension)
    && segments.every((segment) => segment && segment !== "." && segment !== "..")
    && !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment)),
  );
}

export async function githubSourceManifest(
  installationId: bigint,
  repository: string,
  commitSha: string,
) {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Invalid GitHub commit");
  const token = await installationToken(installationId);
  const tree = await githubJson<{
    truncated: boolean;
    tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>;
  }>(
    `/repos/${checkedRepository(repository)}/git/trees/${commitSha}?recursive=1`,
    token,
  );
  if (tree.truncated) throw new Error("GitHub repository tree is truncated");
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
    if (files.length >= MAX_SOURCE_FILES || totalBytes > MAX_SOURCE_BYTES) {
      throw new Error("GitHub repository exceeds the source snapshot budget");
    }
    files.push({ path: item.path, blobSha: item.sha, bytes: item.size ?? 0 });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function readGithubBlob(
  installationId: bigint,
  repository: string,
  blobSha: string,
) {
  if (!/^[0-9a-f]{40}$/.test(blobSha)) throw new Error("Invalid GitHub blob identity");
  const token = await installationToken(installationId);
  const blob = await githubJson<{ encoding: string; content: string; size: number }>(
    `/repos/${checkedRepository(repository)}/git/blobs/${blobSha}`,
    token,
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
  return bytes;
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
