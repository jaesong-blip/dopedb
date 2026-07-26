import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildMeasuredRuntimeProfile,
  runtimeProfilePath,
  validateRuntimeProfile,
} from "./query-runtime-profile.mjs";

test("checked runtime profile is explicit about unavailable Tauri evidence", () => {
  const profile = JSON.parse(fs.readFileSync(runtimeProfilePath, "utf8"));
  assert.doesNotThrow(() => validateRuntimeProfile(profile));
  assert.equal(profile.verificationStatus, "instrumented_not_executed");
  assert.equal(profile.sampleCount, 0);
  assert.equal(profile.metrics, null);
});

test("runtime recorder accepts duration-only samples and enforces absolute budgets", () => {
  const samples = Array.from({ length: 10 }, (_, index) => ({
    interactionToFirstBatchMs: 10 + index,
    interactionToReactInteractiveMs: 20 + index,
  }));
  const profile = buildMeasuredRuntimeProfile({ samples });
  assert.doesNotThrow(() => validateRuntimeProfile(profile));
  profile.metrics.clickToReactInteractiveMs.p95 = 5_001;
  assert.throws(() => validateRuntimeProfile(profile));
});

test("runtime recorder rejects extra fields that could carry result data", () => {
  const samples = Array.from({ length: 10 }, () => ({
    interactionToFirstBatchMs: 10,
    interactionToReactInteractiveMs: 20,
    rowValue: "forbidden",
  }));
  assert.throws(() => buildMeasuredRuntimeProfile({ samples }));
});
