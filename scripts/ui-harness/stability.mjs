#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import {
  ROOT,
  SCENES,
  assertScene,
  parseArgs,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const repeat = Number(args.repeat ?? 20);
if (!Number.isInteger(repeat) || repeat < 2 || repeat > 50) {
  throw new Error("--repeat must be an integer from 2 through 50.");
}
const scenes = args.all
  ? SCENES
  : String(args.scene ?? "first-run,explorer-connected")
      .split(",")
      .map((scene) => assertScene(scene.trim()));

const child = spawnSync(
  "pnpm",
  [
    "exec",
    "playwright",
    "test",
    "--config=playwright.ui-harness.config.ts",
    "tests/ui-harness/specs/stability.harness.ts",
  ],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      UI_HARNESS_STABILITY_SCENES: scenes.join(","),
      UI_HARNESS_STABILITY_REPEAT: String(repeat),
    },
    stdio: "inherit",
  },
);
process.exit(child.status ?? 1);
