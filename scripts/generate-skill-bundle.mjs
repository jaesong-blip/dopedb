import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const skillName = "dopedb-cli";
// Reusing a revision for different bytes would make a known snapshot ambiguous.
// Bump this monotonically whenever the generated package changes after release.
const releaseRevision = 14;
const sourceRoot = path.join(repositoryRoot, "skills", skillName);
const resourceRoot = path.join(repositoryRoot, "src-tauri", "resources", "skills");
const currentManifestPath = path.join(resourceRoot, "current-manifest.json");
const snapshotRegistryPath = path.join(resourceRoot, "snapshot-registry.json");
const releaseMappingPath = path.join(resourceRoot, "release-mapping.json");
const checkOnly = process.argv.includes("--check");

const discoveryStub = `---
name: dopedb-cli
description: Use the local DopeDB Desktop runtime safely through the version-matched dopedb CLI.
---

Before using DopeDB, run:
dopedb skills get dopedb-cli
`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function normalizedText(bytes) {
  return bytes
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC");
}

function fileRecord(relativePath, sourcePath, bytes, content) {
  return {
    path: relativePath,
    sourcePath,
    size: bytes.byteLength,
    executable: false,
    sha256: sha256(bytes),
    normalizedTextSha256: sha256(Buffer.from(normalizedText(bytes), "utf8")),
    ...(content === undefined ? {} : { content }),
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function packageDigest(manifestWithoutDigest) {
  return sha256(Buffer.from(stableJson(manifestWithoutDigest), "utf8"));
}

function assertVersionsMatch() {
  const packageVersion = readJson(path.join(repositoryRoot, "package.json")).version;
  const tauriVersion = readJson(
    path.join(repositoryRoot, "src-tauri", "tauri.conf.json"),
  ).version;
  const cargo = fs.readFileSync(
    path.join(repositoryRoot, "src-tauri", "Cargo.toml"),
    "utf8",
  );
  const cargoVersion = cargo.match(
    /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
  )?.[1];
  if (!packageVersion || packageVersion !== tauriVersion || packageVersion !== cargoVersion) {
    throw new Error(
      `version mismatch: package=${packageVersion}, tauri=${tauriVersion}, cargo=${cargoVersion}`,
    );
  }
  return packageVersion;
}

function sourceRecords() {
  return [
    "SKILL.md",
    "references/dashboards.md",
    "references/documents.md",
    "references/operations.md",
    "references/queries.md",
    "references/safety.md",
  ].map((relativePath) => {
    const bytes = fs.readFileSync(path.join(sourceRoot, relativePath));
    return fileRecord(
      relativePath,
      path.posix.join("skills", skillName, relativePath),
      bytes,
    );
  });
}

function loadRegistry() {
  if (!fs.existsSync(snapshotRegistryPath)) {
    return { schemaVersion: 1, skillName, snapshots: [] };
  }
  const registry = readJson(snapshotRegistryPath);
  if (
    registry.schemaVersion !== 1 ||
    registry.skillName !== skillName ||
    !Array.isArray(registry.snapshots)
  ) {
    throw new Error("snapshot-registry.json has an unsupported shape");
  }
  return registry;
}

function loadReleaseMapping() {
  if (!fs.existsSync(releaseMappingPath)) {
    return { schemaVersion: 1, skillName, releases: [] };
  }
  const mapping = readJson(releaseMappingPath);
  if (
    mapping.schemaVersion !== 1 ||
    mapping.skillName !== skillName ||
    !Array.isArray(mapping.releases)
  ) {
    throw new Error("release-mapping.json has an unsupported shape");
  }
  return mapping;
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeOrCheck(file, value) {
  const expected = serialized(value);
  if (checkOnly) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== expected) {
      throw new Error(`${path.relative(repositoryRoot, file)} is stale`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, expected, { flag: "wx" });
  fs.renameSync(temporary, file);
}

const appVersion = assertVersionsMatch();
const installBytes = Buffer.from(discoveryStub, "utf8");
const manifestBase = {
  schemaVersion: 1,
  skillName,
  releaseRevision,
  sourcePath: path.posix.join("skills", skillName),
  appVersion,
  sourceFiles: sourceRecords(),
  installFiles: [
    fileRecord(
      "SKILL.md",
      "generated:discovery-stub",
      installBytes,
      discoveryStub,
    ),
  ],
};
const currentManifest = {
  ...manifestBase,
  packageDigest: packageDigest(manifestBase),
};

const registry = loadRegistry();
const existingSnapshot = registry.snapshots.find(
  (snapshot) => snapshot.releaseRevision === releaseRevision,
);
if (
  existingSnapshot &&
  existingSnapshot.packageDigest !== currentManifest.packageDigest
) {
  throw new Error(
    `release revision ${releaseRevision} already names different bytes; bump releaseRevision`,
  );
}
const currentSnapshot = {
  releaseRevision,
  appVersion,
  packageDigest: currentManifest.packageDigest,
  files: currentManifest.installFiles.map(({ content: _content, ...file }) => file),
};
const snapshots = registry.snapshots
  .filter((snapshot) => snapshot.releaseRevision !== releaseRevision)
  .concat(currentSnapshot)
  .sort((left, right) => left.releaseRevision - right.releaseRevision);
const snapshotRegistry = { schemaVersion: 1, skillName, snapshots };

const mapping = loadReleaseMapping();
const releases = mapping.releases
  .filter((release) => release.appVersion !== appVersion)
  .concat({
    appVersion,
    releaseRevision,
    packageDigest: currentManifest.packageDigest,
  })
  .sort((left, right) => left.appVersion.localeCompare(right.appVersion));
const releaseMapping = { schemaVersion: 1, skillName, releases };

writeOrCheck(currentManifestPath, currentManifest);
writeOrCheck(snapshotRegistryPath, snapshotRegistry);
writeOrCheck(releaseMappingPath, releaseMapping);

process.stdout.write(
  `${checkOnly ? "verified" : "generated"} ${skillName} revision ${releaseRevision} for app ${appVersion}\n`,
);
