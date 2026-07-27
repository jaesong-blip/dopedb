// Verifies every stable-release version source without trusting first-match
// shell extraction. This intentionally implements only the bounded TOML shapes
// needed for Cargo manifests and Cargo.lock, and fails closed on ambiguity.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(source, reason) {
  throw new Error(source + ": " + reason);
}

function assertStableVersion(value, source) {
  if (typeof value !== "string" || !STABLE_VERSION.test(value)) {
    fail(source, "version must be a stable X.Y.Z string");
  }
  return value;
}

function withoutBom(source) {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

function skipWhitespace(source, index) {
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

function readJsonString(source, index, label) {
  if (source[index] !== "\"") fail(label, "expected a JSON string");
  let cursor = index + 1;
  let escaped = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "\"") {
      const raw = source.slice(index, cursor + 1);
      try {
        return { end: cursor + 1, value: JSON.parse(raw) };
      } catch {
        fail(label, "contains a malformed JSON string");
      }
    }
    cursor += 1;
  }
  fail(label, "contains an unterminated JSON string");
}

function skipJsonValue(source, index, label) {
  const start = skipWhitespace(source, index);
  const first = source[start];
  if (first === "\"") return readJsonString(source, start, label).end;
  if (first === "{" || first === "[") {
    const closing = first === "{" ? "}" : "]";
    const stack = [closing];
    let cursor = start + 1;
    while (cursor < source.length && stack.length > 0) {
      if (source[cursor] === "\"") {
        cursor = readJsonString(source, cursor, label).end;
        continue;
      }
      if (source[cursor] === "{") stack.push("}");
      if (source[cursor] === "[") stack.push("]");
      if (source[cursor] === stack.at(-1)) stack.pop();
      cursor += 1;
    }
    if (stack.length !== 0) fail(label, "contains an unterminated JSON value");
    return cursor;
  }
  let cursor = start;
  while (cursor < source.length && !/[,\]}]/.test(source[cursor])) cursor += 1;
  if (cursor === start) fail(label, "contains an invalid JSON value");
  return cursor;
}

function topLevelJsonEntries(source, label) {
  const text = withoutBom(source);
  try {
    JSON.parse(text);
  } catch {
    fail(label, "is not valid JSON");
  }

  let cursor = skipWhitespace(text, 0);
  if (text[cursor] !== "{") fail(label, "must contain a top-level object");
  cursor = skipWhitespace(text, cursor + 1);
  const entries = [];
  if (text[cursor] === "}") return entries;
  for (;;) {
    const key = readJsonString(text, cursor, label);
    cursor = skipWhitespace(text, key.end);
    if (text[cursor] !== ":") fail(label, "contains a malformed object entry");
    cursor = skipWhitespace(text, cursor + 1);
    const valueStart = cursor;
    cursor = skipJsonValue(text, cursor, label);
    entries.push({ key: key.value, rawValue: text.slice(valueStart, cursor) });
    cursor = skipWhitespace(text, cursor);
    if (text[cursor] === "}") break;
    if (text[cursor] !== ",") fail(label, "contains a malformed object separator");
    cursor = skipWhitespace(text, cursor + 1);
  }
  cursor = skipWhitespace(text, cursor + 1);
  if (cursor !== text.length) fail(label, "contains trailing JSON content");
  return entries;
}

export function verifyJsonVersion(source, expectedVersion, label) {
  assertStableVersion(expectedVersion, "release tag");
  const versions = topLevelJsonEntries(source, label).filter((entry) => entry.key === "version");
  if (versions.length !== 1) fail(label, "must contain exactly one top-level version field");
  let value;
  try {
    value = JSON.parse(versions[0].rawValue);
  } catch {
    fail(label, "version must be a JSON string");
  }
  if (typeof value !== "string") fail(label, "version must be a JSON string");
  if (assertStableVersion(value, label) !== expectedVersion) fail(label, "version does not match the release tag");
  return value;
}

function tomlHeader(line, label) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[")) return undefined;
  const match = /^(\[\[|\[)\s*(.*?)\s*(\]\]|\])\s*(?:#.*)?$/.exec(trimmed);
  if (!match || (match[1] === "[[" ? match[3] !== "]]" : match[3] !== "]")) {
    fail(label, "contains a malformed TOML table header");
  }
  if (!match[2]) fail(label, "contains an empty TOML table header");
  return { array: match[1] === "[[", name: match[2] };
}

function tomlStringAssignment(line, key, label) {
  const match = new RegExp("^\\s*" + key + "\\s*=\\s*\"([^\"\\\\\\r\\n]*)\"\\s*(?:#.*)?$").exec(line);
  if (!match) fail(label, key + " must be a single quoted TOML string");
  return match[1];
}

function directTomlKey(line) {
  const match = /^\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=/.exec(line);
  return match ? match[1] ?? match[2] : undefined;
}

function sourceLines(source) {
  return withoutBom(source).replace(/\r\n?/g, "\n").split("\n");
}

export function verifyCargoManifestVersion(source, expectedVersion, label) {
  assertStableVersion(expectedVersion, "release tag");
  let activeTable;
  let packageTableCount = 0;
  const versions = [];

  for (const rawLine of sourceLines(source)) {
    if (/^\s*(?:#|$)/.test(rawLine)) continue;
    const header = tomlHeader(rawLine, label);
    if (header) {
      activeTable = header.array ? "[[" + header.name + "]]" : header.name;
      if (header.name === "package") {
        if (header.array) fail(label, "must use one [package] table, not [[package]]");
        packageTableCount += 1;
      }
      continue;
    }
    if (directTomlKey(rawLine) !== "version") continue;
    if (activeTable !== "package") fail(label, "version appears outside [package]");
    versions.push(tomlStringAssignment(rawLine, "version", label));
  }

  if (packageTableCount !== 1) fail(label, "must contain exactly one [package] table");
  if (versions.length !== 1) fail(label, "[package] must contain exactly one version");
  if (assertStableVersion(versions[0], label) !== expectedVersion) fail(label, "version does not match the release tag");
  return versions[0];
}

function lockPackageBlock(line) {
  return line.trim() === "[[package]]";
}

export function verifyCargoLockPackageVersion(source, expectedVersion, packageName, label) {
  assertStableVersion(expectedVersion, "release tag");
  let active;
  let rootFormatVersions = 0;
  const blocks = [];

  for (const rawLine of sourceLines(source)) {
    if (/^\s*(?:#|$)/.test(rawLine)) continue;
    if (lockPackageBlock(rawLine)) {
      active = { names: [], versions: [] };
      blocks.push(active);
      continue;
    }
    const header = tomlHeader(rawLine, label);
    if (header) {
      active = undefined;
      continue;
    }

    const key = directTomlKey(rawLine);
    if (key !== "name" && key !== "version") continue;
    if (!active) {
      if (key === "version" && blocks.length === 0 && /^\s*version\s*=\s*[0-9]+\s*(?:#.*)?$/.test(rawLine)) {
        rootFormatVersions += 1;
        continue;
      }
      fail(label, key + " appears outside a [[package]] block");
    }
    if (key === "name") active.names.push(tomlStringAssignment(rawLine, "name", label));
    if (key === "version") active.versions.push(tomlStringAssignment(rawLine, "version", label));
  }

  if (rootFormatVersions !== 1) fail(label, "must contain exactly one numeric lockfile version");
  for (const block of blocks) {
    if (block.names.length !== 1) fail(label, "each [[package]] block must contain exactly one name");
    if (block.versions.length !== 1) fail(label, "each [[package]] block must contain exactly one version");
  }
  const matches = blocks.filter((block) => block.names[0] === packageName);
  if (matches.length !== 1) fail(label, "must contain exactly one [[package]] block named " + packageName);
  if (assertStableVersion(matches[0].versions[0], label) !== expectedVersion) {
    fail(label, "package version does not match the release tag");
  }
  return matches[0].versions[0];
}

export function verifyReleaseVersionContents({
  expectedVersion,
  packageJson,
  tauriConfig,
  appCargoToml,
  cargoLock,
  cliCargoToml,
}) {
  assertStableVersion(expectedVersion, "release tag");
  verifyJsonVersion(packageJson, expectedVersion, "package.json");
  verifyJsonVersion(tauriConfig, expectedVersion, "src-tauri/tauri.conf.json");
  verifyCargoManifestVersion(appCargoToml, expectedVersion, "src-tauri/Cargo.toml");
  verifyCargoLockPackageVersion(cargoLock, expectedVersion, "dopedb", "Cargo.lock dopedb");
  verifyCargoManifestVersion(cliCargoToml, expectedVersion, "dopedb-cli/Cargo.toml");
  verifyCargoLockPackageVersion(cargoLock, expectedVersion, "dopedb-cli", "Cargo.lock dopedb-cli");
  return expectedVersion;
}

export async function verifyReleaseVersionFiles(expectedVersion, root = process.cwd()) {
  const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
  let sourceFiles;
  try {
    sourceFiles = await Promise.all([
      read("package.json"),
      read("src-tauri/tauri.conf.json"),
      read("src-tauri/Cargo.toml"),
      read("Cargo.lock"),
      read("dopedb-cli/Cargo.toml"),
    ]);
  } catch {
    fail("release version sources", "a required source cannot be read");
  }
  const [packageJson, tauriConfig, appCargoToml, cargoLock, cliCargoToml] = sourceFiles;
  return verifyReleaseVersionContents({
    expectedVersion,
    packageJson,
    tauriConfig,
    appCargoToml,
    cargoLock,
    cliCargoToml,
  });
}

async function main() {
  const [expectedVersion] = process.argv.slice(2);
  if (process.argv.length !== 3) fail("release tag", "expected exactly one version argument");
  await verifyReleaseVersionFiles(expectedVersion);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Stable release version verification failed: " + (error instanceof Error ? error.message : "invalid version source"));
    process.exitCode = 1;
  });
}
