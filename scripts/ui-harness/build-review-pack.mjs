#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import {
  ROOT,
  loadBaselineManifest,
  parseArgs,
  readJson,
  resolveRunAndScene,
  reviewSceneDir,
  snapshotPath,
  writeJson,
} from "./lib.mjs";

function imageDataUri(file) {
  if (!file || !fs.existsSync(file)) return null;
  return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fitToActual(source, width, height) {
  const output = new PNG({ width, height });
  if (!source) return output;
  PNG.bitblt(
    source,
    output,
    0,
    0,
    Math.min(source.width, width),
    Math.min(source.height, height),
    0,
    0,
  );
  return output;
}

function renderImagePanel(label, file, note = "") {
  const data = imageDataUri(file);
  return `<figure>
    <figcaption><strong>${escapeHtml(label)}</strong><span>${escapeHtml(note)}</span></figcaption>
    ${
      data
        ? `<img alt="${escapeHtml(label)}" src="${data}">`
        : `<div class="missing">Not available in this local review pack</div>`
    }
  </figure>`;
}

export function buildReviewPack({
  run,
  scene,
  preservePrevious = false,
}) {
  const directory = reviewSceneDir(run, scene);
  const actualFile = path.join(directory, "actual.png");
  const cloneFile = path.join(directory, "reference-clone.png");
  const captureMetadataFile = path.join(directory, "capture-metadata.json");
  if (
    !fs.existsSync(actualFile) ||
    !fs.existsSync(cloneFile) ||
    !fs.existsSync(captureMetadataFile)
  ) {
    throw new Error(
      `Capture is incomplete for ${run}/${scene}; run ui:harness:capture first.`,
    );
  }

  const capture = readJson(captureMetadataFile);
  const manifest = readJson(
    path.join(ROOT, "tests", "ui-benchmark", "manifest.json"),
  );
  const reference = manifest.references.find(
    (entry) => entry.id === capture.referenceId,
  );
  if (!reference) {
    throw new Error(`Unknown benchmark reference: ${capture.referenceId}`);
  }
  writeJson(path.join(directory, "reference-metadata.json"), reference);

  const referenceFile =
    reference.distribution === "repository-audit" && reference.file
      ? path.join(ROOT, reference.file)
      : null;
  const localReferenceCopy = path.join(directory, "reference.png");
  if (referenceFile && fs.existsSync(referenceFile)) {
    fs.copyFileSync(referenceFile, localReferenceCopy);
  }

  const previousFile = path.join(directory, "previous.png");
  const approved = loadBaselineManifest().baselines.find(
    (entry) => entry.scene === scene,
  );
  const approvedFile = approved?.file ? path.join(ROOT, approved.file) : null;
  if (
    (!preservePrevious || !fs.existsSync(previousFile)) &&
    approvedFile &&
    fs.existsSync(approvedFile)
  ) {
    fs.copyFileSync(approvedFile, previousFile);
  }

  const actual = PNG.sync.read(fs.readFileSync(actualFile));
  const previous = fs.existsSync(previousFile)
    ? PNG.sync.read(fs.readFileSync(previousFile))
    : null;
  const fittedPrevious = fitToActual(previous, actual.width, actual.height);
  const diff = new PNG({ width: actual.width, height: actual.height });
  const changedPixels = pixelmatch(
    fittedPrevious.data,
    actual.data,
    diff.data,
    actual.width,
    actual.height,
    { threshold: 0.2, includeAA: false },
  );
  fs.writeFileSync(path.join(directory, "diff.png"), PNG.sync.write(diff));
  writeJson(path.join(directory, "diff-summary.json"), {
    changedPixels,
    totalPixels: actual.width * actual.height,
    changedRatio: changedPixels / (actual.width * actual.height),
    previousBaselineAvailable: previous !== null,
  });

  const template = {
    schemaVersion: 1,
    scene,
    referenceId: reference.id,
    scores: {
      orientation: 0,
      workbenchHierarchy: 0,
      densityAndAlignment: 0,
      actionLocality: 0,
      contextContinuity: 0,
      accessibility: 0,
    },
    findings: [],
    reviewer: "human",
    blocking: false,
  };
  writeJson(path.join(directory, "scorecard-template.json"), template);
  fs.copyFileSync(
    path.join(
      ROOT,
      "tests",
      "ui-benchmark",
      "review",
      "review-prompt.md",
    ),
    path.join(directory, "review-prompt.md"),
  );

  const measurements = readJson(path.join(directory, "measurements.json"));
  const ipc = readJson(path.join(directory, "ipc-calls.json"));
  const diffSummary = readJson(path.join(directory, "diff-summary.json"));
  const panels = [
    renderImagePanel(
      "Reference metadata image",
      fs.existsSync(localReferenceCopy) ? localReferenceCopy : null,
      reference.distribution,
    ),
    renderImagePanel("Clean-room reference clone", cloneFile),
    renderImagePanel("Current actual app", actualFile),
    renderImagePanel(
      "Previously approved actual",
      fs.existsSync(previousFile) ? previousFile : null,
    ),
    renderImagePanel("Pixel diff", path.join(directory, "diff.png")),
  ].join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>UI review — ${escapeHtml(scene)}</title>
<style>
  :root { color-scheme: dark; font: 13px/1.5 ui-sans-serif, system-ui; background:#111317; color:#e5e7eb; }
  * { box-sizing:border-box; } body { margin:0; padding:24px; }
  header { display:flex; justify-content:space-between; gap:20px; align-items:end; margin-bottom:20px; }
  h1 { margin:0; font-size:22px; } p { margin:4px 0 0; color:#9ca3af; }
  .badge { padding:5px 9px; border:1px solid #374151; border-radius:99px; color:#bfdbfe; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:14px; }
  figure { min-width:0; margin:0; border:1px solid #30343b; background:#191c21; }
  figcaption { min-height:42px; display:flex; justify-content:space-between; gap:12px; padding:10px 12px; border-bottom:1px solid #30343b; }
  figcaption span { color:#8f96a3; } img { display:block; width:100%; height:auto; background:#0b0d10; }
  .missing { min-height:220px; display:grid; place-items:center; color:#8f96a3; }
  .evidence { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:14px; }
  pre { max-height:420px; margin:0; padding:14px; overflow:auto; border:1px solid #30343b; background:#15171b; white-space:pre-wrap; }
  @media(max-width:800px){ .evidence{grid-template-columns:1fr;} body{padding:12px;} }
</style></head><body>
<header><div><h1>${escapeHtml(scene)}</h1><p>Run ${escapeHtml(run)} · non-blocking reference review; actual baseline approval is separate.</p></div>
<span class="badge">${diffSummary.changedPixels.toLocaleString()} changed pixels</span></header>
<section class="grid">${panels}</section>
<section class="evidence"><pre aria-label="Measurements">${escapeHtml(
    JSON.stringify(measurements, null, 2),
  )}</pre><pre aria-label="IPC calls">${escapeHtml(
    JSON.stringify(ipc, null, 2),
  )}</pre></section>
</body></html>`;
  fs.writeFileSync(path.join(directory, "review.html"), html);
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { run, scene } = resolveRunAndScene(parseArgs(process.argv.slice(2)));
  const directory = buildReviewPack({ run, scene });
  console.log(
    `UI review pack built: ${path.relative(ROOT, directory)}/review.html`,
  );
}
