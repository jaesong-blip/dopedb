// Keeps contributor authorship separate from the repository owner's one-shot
// wrappers and keeps product runtime identities inside a product-owned namespace.
export function collectRepositoryIdentityDiagnostics({ exists, read, relative, walk }) {
  const diagnostics = [];
  const packageScripts = JSON.parse(read("package.json")).scripts ?? {};
  const expectedOwnerScript = "bash scripts/with-repository-owner-identity.sh";
  const productionIdentifier = "dev.dopedb.desktop";

  for (const [filePath, field, expected] of [
    ["src-tauri/tauri.conf.json", "identifier", productionIdentifier],
    ["src-tauri/tauri.dev.conf.json", "identifier", `${productionIdentifier}.dev`],
    ["src-tauri/tauri.benchmark.conf.json", "identifier", `${productionIdentifier}.benchmark`],
    [".release/macos-distribution.json", "bundleIdentifier", productionIdentifier],
  ]) {
    const value = JSON.parse(read(filePath))[field];
    if (value !== expected) {
      diagnostics.push(`${filePath}: ${field} must use the reviewed product-owned namespace`);
    }
  }

  for (const [filePath, expectedIdentifiers] of [
    [
      "src-tauri/src/broker/discovery.rs",
      [productionIdentifier, `${productionIdentifier}.dev`, `${productionIdentifier}.benchmark`],
    ],
    [
      "src-tauri/src/connection/keychain.rs",
      [productionIdentifier, `${productionIdentifier}.dev`],
    ],
    [
      "src-tauri/src/features/providers/adapters/keychain_vault.rs",
      [productionIdentifier, `${productionIdentifier}.dev`, `${productionIdentifier}.benchmark`],
    ],
  ]) {
    const source = read(filePath);
    for (const identifier of expectedIdentifiers) {
      if (!source.includes(`"${identifier}"`)) {
        diagnostics.push(`${filePath}: reviewed product identifier is missing (${identifier})`);
      }
    }
  }

  if (Object.hasOwn(packageScripts, "repo:identity")) {
    diagnostics.push("package.json: generic repo:identity must not rewrite contributor authorship");
  }
  if (packageScripts["repo:owner-identity"] !== expectedOwnerScript) {
    diagnostics.push("package.json: owner identity must use the reviewed one-shot wrapper");
  }
  if (exists("scripts/configure-repository-identity.sh")) {
    diagnostics.push("scripts/configure-repository-identity.sh: persistent repository identity setter returned");
  }

  for (const policyPath of [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTRIBUTING.md",
    "docs/commit.md",
    "docs/github-account-switching.md",
  ]) {
    if (read(policyPath).includes("pnpm repo:identity")) {
      diagnostics.push(`${policyPath}: generic owner identity instruction returned`);
    }
  }

  for (const absoluteScript of walk("scripts").filter((file) => file.endsWith(".sh"))) {
    const script = relative(absoluteScript);
    const source = read(script);
    if (/\bgit\s+config\s+(?:--local|--global)\s+user\.(?:name|email)\b/.test(source)) {
      diagnostics.push(`${script}: scripts must not persist a contributor Git identity override`);
    }
  }

  const wrapperPath = "scripts/with-repository-owner-identity.sh";
  if (!exists(wrapperPath)) {
    diagnostics.push(`${wrapperPath}: reviewed owner-only wrapper is missing`);
  } else {
    const wrapper = read(wrapperPath);
    for (const marker of [
      'if [ "$(git branch --show-current)" != "main" ]',
      'GIT_AUTHOR_NAME="$owner_name"',
      'GIT_COMMITTER_NAME="$owner_name"',
      "only git commit or annotated git tag is allowed",
    ]) {
      if (!wrapper.includes(marker)) {
        diagnostics.push(`${wrapperPath}: one-shot owner boundary marker is missing (${marker})`);
      }
    }
  }

  if (!read("scripts/release/create-stable-draft.sh").includes(
    'pnpm repo:owner-identity -- git tag -a "$tag"',
  )) {
    diagnostics.push("scripts/release/create-stable-draft.sh: stable tag must use the one-shot owner identity wrapper");
  }

  return diagnostics;
}
