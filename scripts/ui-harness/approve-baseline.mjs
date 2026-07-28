#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildReviewPack } from "./build-review-pack.mjs";
import {
  BASELINE_MANIFEST,
  ROOT,
  assertUnrelatedBaselineHashes,
  captureUnrelatedBaselineHashes,
  loadBaselineManifest,
  parseArgs,
  readJson,
  relativeToRoot,
  resolveRunAndScene,
  reviewSceneDir,
  sha256File,
  snapshotPath,
  verifyBaselineInventory,
  writeJson,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const { run, scene } = resolveRunAndScene(args);
if (typeof args.reason !== "string" || args.reason.trim().length < 8) {
  throw new Error("--reason is required and must explain the visual change.");
}

const directory = reviewSceneDir(run, scene);
const candidate = path.join(directory, "actual.png");
const captureMetadata = path.join(directory, "capture-metadata.json");
if (!fs.existsSync(candidate) || !fs.existsSync(captureMetadata)) {
  throw new Error(`Candidate capture is missing for ${run}/${scene}.`);
}

const manifest = loadBaselineManifest();
const before = verifyBaselineInventory({ manifest, requireAll: false });
const unrelated = captureUnrelatedBaselineHashes(before, scene);

// Preserve the comparison against the pre-approval baseline before replacing it.
buildReviewPack({ run, scene });

const target = snapshotPath(scene);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(candidate, target);

const capture = readJson(captureMetadata);
const entry = {
  scene,
  viewport: capture.viewport,
  sha256: sha256File(target),
  benchmarkReference: capture.referenceId,
  file: relativeToRoot(target),
  reason: args.reason.trim(),
  approvedAt: new Date().toISOString().slice(0, 10),
};
const baselines = manifest.baselines
  .filter((baseline) => baseline.scene !== scene)
  .concat(entry)
  .sort((left, right) => left.scene.localeCompare(right.scene));
writeJson(BASELINE_MANIFEST, { schemaVersion: 1, baselines });

verifyBaselineInventory({
  manifest: { schemaVersion: 1, baselines },
  requireAll: false,
});
assertUnrelatedBaselineHashes(unrelated);

buildReviewPack({ run, scene, preservePrevious: true });
console.log(
  `Approved ${scene}: ${entry.sha256} (${relativeToRoot(BASELINE_MANIFEST)})`,
);
