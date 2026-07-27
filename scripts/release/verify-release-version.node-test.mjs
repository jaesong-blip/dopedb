// Exercises the failure-closed version-source parser with deliberately
// ambiguous manifests and lockfile blocks that shell first-match parsing misses.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  verifyCargoLockPackageVersion,
  verifyCargoManifestVersion,
  verifyReleaseVersionContents,
  verifyReleaseVersionFiles,
} from "./verify-release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VERSION = "1.2.3";

function cargoManifest(name, version = VERSION) {
  return [
    "[package]",
    "name = \"" + name + "\"",
    "version = \"" + version + "\"",
    "edition = \"2021\"",
    "",
    "[dependencies]",
    "serde = \"1\"",
    "",
  ].join("\n");
}

function lockBlock(name, version = VERSION) {
  return [
    "[[package]]",
    "name = \"" + name + "\"",
    "version = \"" + version + "\"",
    "",
  ].join("\n");
}

function cargoLock(dopedbVersion = VERSION, cliVersion = VERSION) {
  return [
    "version = 4",
    "",
    lockBlock("dopedb", dopedbVersion),
    lockBlock("dopedb-cli", cliVersion),
    lockBlock("serde", "1.0.0"),
  ].join("\n");
}

function sources(overrides = {}) {
  return {
    expectedVersion: VERSION,
    packageJson: "{\"name\":\"dopedb\",\"version\":\"1.2.3\"}",
    tauriConfig: "{\"version\":\"1.2.3\"}",
    appCargoToml: cargoManifest("dopedb"),
    cargoLock: cargoLock(),
    cliCargoToml: cargoManifest("dopedb-cli"),
    ...overrides,
  };
}

test("accepts exactly the six aligned stable release sources", () => {
  assert.equal(verifyReleaseVersionContents(sources()), VERSION);
});

test("verifies the checked-in six release sources", async () => {
  const expectedVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
  assert.equal(await verifyReleaseVersionFiles(expectedVersion, root), expectedVersion);
});

test("rejects every mismatched intended version source", () => {
  const mismatches = [
    ["package.json", { packageJson: "{\"version\":\"1.2.4\"}" }],
    ["tauri config", { tauriConfig: "{\"version\":\"1.2.4\"}" }],
    ["app manifest", { appCargoToml: cargoManifest("dopedb", "1.2.4") }],
    ["dopedb lock block", { cargoLock: cargoLock("1.2.4") }],
    ["CLI manifest", { cliCargoToml: cargoManifest("dopedb-cli", "1.2.4") }],
    ["CLI lock block", { cargoLock: cargoLock(VERSION, "1.2.4") }],
  ];
  for (const [name, override] of mismatches) {
    assert.throws(() => verifyReleaseVersionContents(sources(override)), Error, name);
  }
});

test("rejects duplicate, misplaced, and malformed JSON version values", () => {
  for (const [name, packageJson] of [
    ["duplicate top-level version", "{\"version\":\"1.2.3\",\"version\":\"1.2.3\"}"],
    ["nested-only version", "{\"meta\":{\"version\":\"1.2.3\"}}"],
    ["numeric version", "{\"version\":123}"],
    ["malformed stable version", "{\"version\":\"01.2.3\"}"],
  ]) {
    assert.throws(() => verifyReleaseVersionContents(sources({ packageJson })), Error, name);
  }
});

test("rejects ambiguous Cargo manifest package tables and version placement", () => {
  const duplicatePackage = cargoManifest("dopedb") + cargoManifest("dopedb");
  const versionOutsidePackage = [
    "[package]",
    "name = \"dopedb\"",
    "",
    "[lib]",
    "version = \"1.2.3\"",
  ].join("\n");
  const malformedVersion = cargoManifest("dopedb").replace("version = \"1.2.3\"", "version = '1.2.3'");
  const duplicateVersion = cargoManifest("dopedb").replace("edition = \"2021\"", "version = \"1.2.3\"\nedition = \"2021\"");
  for (const [name, manifest] of [
    ["duplicate package table", duplicatePackage],
    ["version outside package", versionOutsidePackage],
    ["malformed version string", malformedVersion],
    ["duplicate package version", duplicateVersion],
  ]) {
    assert.throws(() => verifyCargoManifestVersion(manifest, VERSION, "fixture Cargo.toml"), Error, name);
  }
});

test("rejects duplicate, misplaced, and malformed target Cargo.lock blocks", () => {
  const duplicateDopedb = cargoLock() + lockBlock("dopedb");
  const duplicateVersion = cargoLock().replace(
    "name = \"dopedb\"\nversion = \"1.2.3\"",
    "name = \"dopedb\"\nversion = \"1.2.3\"\nversion = \"1.2.3\"",
  );
  const misplacedVersion = cargoLock() + "\n[metadata]\nversion = \"1.2.3\"\n";
  const malformedVersion = cargoLock().replace(
    "name = \"dopedb-cli\"\nversion = \"1.2.3\"",
    "name = \"dopedb-cli\"\nversion = 123",
  );
  const duplicateName = cargoLock().replace(
    "name = \"dopedb-cli\"\nversion = \"1.2.3\"",
    "name = \"dopedb-cli\"\nname = \"dopedb-cli\"\nversion = \"1.2.3\"",
  );
  for (const [name, lock] of [
    ["duplicate dopedb block", duplicateDopedb],
    ["duplicate target version", duplicateVersion],
    ["version outside package block", misplacedVersion],
    ["malformed CLI version", malformedVersion],
    ["duplicate CLI package name", duplicateName],
  ]) {
    assert.throws(() => {
      verifyCargoLockPackageVersion(lock, VERSION, "dopedb", "fixture Cargo.lock");
      verifyCargoLockPackageVersion(lock, VERSION, "dopedb-cli", "fixture Cargo.lock");
    }, Error, name);
  }
});

test("rejects malformed release tag versions before reading source values", () => {
  for (const version of ["", "v1.2.3", "1.2", "01.2.3", "1.2.3-beta"]) {
    assert.throws(() => verifyReleaseVersionContents({ ...sources(), expectedVersion: version }), Error, version || "empty");
  }
});
