#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  REVIEW_ROOT,
  ROOT,
  assertRunId,
  assertScene,
  defaultRunId,
  parseArgs,
  reviewSceneDir,
  writeJson,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const scene = assertScene(args.scene);
const run = assertRunId(args.run || defaultRunId());
const destination = reviewSceneDir(run, scene);

if (fs.existsSync(destination)) {
  throw new Error(
    `Capture destination already exists: ${path.relative(ROOT, destination)}. ` +
      "Choose a new --run id.",
  );
}
fs.mkdirSync(destination, { recursive: true });

const child = spawnSync(
  "pnpm",
  [
    "exec",
    "playwright",
    "test",
    "--config=playwright.ui-harness.config.ts",
    "tests/ui-harness/specs/capture.harness.ts",
  ],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      UI_HARNESS_CAPTURE_SCENE: scene,
      UI_HARNESS_CAPTURE_RUN: run,
      UI_HARNESS_CAPTURE_DIR: destination,
    },
    stdio: "inherit",
  },
);

if (child.status !== 0) {
  process.exit(child.status ?? 1);
}

writeJson(path.join(REVIEW_ROOT, "latest.json"), { run, scene });
console.log(`UI candidate captured: output/playwright/ui-review/${run}/${scene}`);
