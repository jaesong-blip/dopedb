import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const REVIEW_ROOT = path.join(ROOT, "output", "playwright", "ui-review");
export const SNAPSHOT_ROOT = path.join(
  ROOT,
  "tests",
  "ui-harness",
  "__screenshots__",
  "chromium-macos",
  "shell.harness.ts",
);
export const BASELINE_MANIFEST = path.join(
  ROOT,
  "tests",
  "ui-benchmark",
  "approvals",
  "baseline-manifest.json",
);

export const SCENES = [
  "first-run",
  "explorer-connected",
  "compact-shell",
  "terminal-open",
  "table-data",
  "sql-terminal",
  "schema-erd",
  "dashboard",
  "settings",
  "provider-setup",
  "permission-review",
  "loading-error",
  "empty-results",
  "long-content",
  "keyboard-only",
];

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals === -1 ? undefined : equals);
    if (equals !== -1) {
      result[key] = token.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

export function assertScene(scene) {
  if (!SCENES.includes(scene)) {
    throw new Error(
      `--scene must be one of: ${SCENES.join(", ")} (received ${scene ?? "<missing>"})`,
    );
  }
  return scene;
}

export function assertRunId(run) {
  if (
    typeof run !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(run) ||
    run.includes("..")
  ) {
    throw new Error(`Unsafe run id: ${run ?? "<missing>"}`);
  }
  return run;
}

export function defaultRunId() {
  return new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "")
    .replace("T", "-");
}

export function reviewSceneDir(run, scene) {
  return path.join(REVIEW_ROOT, assertRunId(run), assertScene(scene));
}

export function snapshotPath(scene) {
  return path.join(SNAPSHOT_ROOT, `${assertScene(scene)}.png`);
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readLatestCapture() {
  const pointer = path.join(REVIEW_ROOT, "latest.json");
  if (!fs.existsSync(pointer)) {
    throw new Error(
      "No captured candidate exists. Run pnpm ui:harness:capture first.",
    );
  }
  const latest = readJson(pointer);
  return {
    run: assertRunId(latest.run),
    scene: assertScene(latest.scene),
  };
}

export function resolveRunAndScene(args) {
  const latest =
    args.run && args.scene ? null : readLatestCapture();
  return {
    run: assertRunId(args.run || latest?.run),
    scene: assertScene(args.scene || latest?.scene),
  };
}

export function loadBaselineManifest() {
  if (!fs.existsSync(BASELINE_MANIFEST)) {
    return { schemaVersion: 1, baselines: [] };
  }
  return readJson(BASELINE_MANIFEST);
}

export function verifyBaselineInventory({
  manifest = loadBaselineManifest(),
  requireAll = false,
  root = ROOT,
  snapshotRoot = SNAPSHOT_ROOT,
  knownScenes = SCENES,
} = {}) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.baselines)) {
    throw new Error("Unsupported or malformed baseline manifest.");
  }
  const byScene = new Map();
  for (const baseline of manifest.baselines) {
    if (!knownScenes.includes(baseline.scene)) {
      throw new Error(`Unknown baseline scene: ${baseline.scene}`);
    }
    if (byScene.has(baseline.scene)) {
      throw new Error(`Duplicate baseline entry: ${baseline.scene}`);
    }
    if (!baseline.file || !/^[0-9a-f]{64}$/.test(baseline.sha256 ?? "")) {
      throw new Error(`Malformed baseline entry: ${baseline.scene}`);
    }
    const file = path.join(root, baseline.file);
    if (!fs.existsSync(file)) {
      throw new Error(`Approved snapshot is missing: ${baseline.file}`);
    }
    const actual = sha256File(file);
    if (actual !== baseline.sha256) {
      throw new Error(
        `Approved snapshot hash mismatch for ${baseline.scene}: ` +
          `${baseline.sha256} != ${actual}`,
      );
    }
    byScene.set(baseline.scene, { ...baseline, absoluteFile: file });
  }

  const pngs = fs.existsSync(snapshotRoot)
    ? fs
        .readdirSync(snapshotRoot)
        .filter((file) => file.endsWith(".png"))
        .sort()
    : [];
  const approvedFiles = new Set(
    [...byScene.values()].map((entry) => path.basename(entry.absoluteFile)),
  );
  const unknown = pngs.filter((file) => !approvedFiles.has(file));
  if (unknown.length > 0) {
    throw new Error(
      `Unapproved snapshot file(s): ${unknown.join(", ")}. ` +
        "Use ui:harness:approve for one explicit scene.",
    );
  }
  if (requireAll) {
    const missing = knownScenes.filter((scene) => !byScene.has(scene));
    if (missing.length > 0) {
      throw new Error(`Missing approved baseline(s): ${missing.join(", ")}`);
    }
  }
  return byScene;
}

export function assertUniqueSceneSet(sceneIds, expected = SCENES) {
  const duplicate = sceneIds.find(
    (scene, index) => sceneIds.indexOf(scene) !== index,
  );
  if (duplicate) throw new Error(`Duplicate scenario id: ${duplicate}`);
  const missing = expected.filter((scene) => !sceneIds.includes(scene));
  const extra = sceneIds.filter((scene) => !expected.includes(scene));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Scenario set mismatch; missing=[${missing.join(", ")}], ` +
        `extra=[${extra.join(", ")}]`,
    );
  }
}

export function captureUnrelatedBaselineHashes(inventory, targetScene) {
  return new Map(
    [...inventory.entries()]
      .filter(([scene]) => scene !== targetScene)
      .map(([scene, baseline]) => [
        scene,
        {
          file: baseline.absoluteFile,
          sha256: sha256File(baseline.absoluteFile),
        },
      ]),
  );
}

export function assertUnrelatedBaselineHashes(unrelated) {
  for (const [scene, baseline] of unrelated) {
    if (!fs.existsSync(baseline.file)) {
      throw new Error(`Refusing approval: unrelated snapshot is missing (${scene}).`);
    }
    if (sha256File(baseline.file) !== baseline.sha256) {
      throw new Error(`Refusing approval: unrelated snapshot changed (${scene}).`);
    }
  }
}

export function relativeToRoot(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}
