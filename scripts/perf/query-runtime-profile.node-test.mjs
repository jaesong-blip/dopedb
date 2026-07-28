import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildMeasuredRuntimeProfile,
  runtimeProfilePath,
  validateRuntimeProfile,
} from "./query-runtime-profile.mjs";

test("checked runtime profile contains measured Tauri WebView evidence", () => {
  const profile = JSON.parse(fs.readFileSync(runtimeProfilePath, "utf8"));
  assert.doesNotThrow(() => validateRuntimeProfile(profile));
  assert.equal(profile.verificationStatus, "measured");
  assert.ok(profile.sampleCount >= 10);
  assert.ok(
    profile.metrics.clickToFirstBatchMs.p95 <=
      profile.budgets.maxClickToFirstBatchP95Ms,
  );
  assert.ok(
    profile.metrics.clickToReactInteractiveMs.p95 <=
      profile.budgets.maxClickToReactInteractiveP95Ms,
  );
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

test("checked phase profile records bounded post-interactive costs and decisions", () => {
  const profile = JSON.parse(
    fs.readFileSync(
      new URL("./query-runtime-phase-profile.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.verificationStatus, "measured");
  assert.ok(profile.workload.sampleCount >= 10);
  assert.equal(
    profile.workload.batchesPerRun,
    Math.ceil(profile.workload.rows / profile.workload.batchRows),
  );
  assert.ok(profile.metrics.auditPersistUs.p95 < 1_000);
  assert.ok(profile.metrics.historyPersistUs.p95 < 1_000);
  assert.ok(profile.metrics.poolConnectUs.p95 < 1_000);
  assert.match(profile.decisions.sqliteProvenance, /no measured UX benefit/);
  assert.match(profile.decisions.poolInitialization, /lazy write-pool/);
});

test("checked competitor baseline preserves comparable scope and limitations", () => {
  const baseline = JSON.parse(
    fs.readFileSync(
      new URL("./query-competitor-baseline.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.verificationStatus, "measured");
  assert.equal(baseline.fixture.engine, "SQLite");
  assert.equal(baseline.fixture.sha256.length, 64);
  assert.equal(baseline.workload.resultWindowRows, 1_000);
  assert.equal(baseline.dopedb.sampleCount, 12);
  assert.equal(baseline.chat2db.sampleCount, 20);
  assert.match(baseline.dopedb.commit, /^[0-9a-f]{40}$/);
  assert.match(baseline.chat2db.commit, /^[0-9a-f]{40}$/);
  assert.ok(
    baseline.chat2db.responseBytes.min <=
      baseline.chat2db.responseBytes.max,
  );
  assert.equal(
    baseline.dopedb.firstWindowAckRows,
    Math.ceil(
      baseline.workload.resultWindowRows / baseline.dopedb.batchRows,
    ) * baseline.dopedb.batchRows,
  );
  assert.match(baseline.chat2db.repository, /CodePhiliaX\/Chat2DB/);
  assert.match(baseline.comparisonScope, /not an end-user UI ranking/);
  assert.ok(
    baseline.limitations.some((limitation) =>
      limitation.includes("desktop click-to-render timing is not claimed"),
    ),
  );
  assert.match(baseline.decision, /bounded Channel streaming/);
});
