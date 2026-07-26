import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { nearestRank, validateSummary } from "./query-grid.mjs";

test("nearest rank uses ceil(p*N)-1", () => {
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(nearestRank(values, 0.5), 10);
  assert.equal(nearestRank(values, 0.95), 19);
});

test("benchmark allocates row sources before the commit timer and RSS baseline", () => {
  const source = fs.readFileSync(
    new URL("../../src/components/DataGridVirtual.perf.test.tsx", import.meta.url),
    "utf8",
  );
  const sample = source.slice(
    source.indexOf("async function renderSample"),
    source.indexOf('describe("DataGridVirtual performance artifact"'),
  );
  const measuredSource = sample.indexOf("const measuredSource = sourceFor(rows)");
  const rssBaseline = sample.indexOf(
    "const rssBeforeCommit = process.memoryUsage().rss",
  );
  const timerStart = sample.indexOf("const started = performance.now()");
  const timerEnd = sample.indexOf(
    "const commitMs = performance.now() - started",
  );
  assert.ok(measuredSource >= 0 && measuredSource < rssBaseline);
  assert.ok(rssBaseline < timerStart && timerStart < timerEnd);
  assert.doesNotMatch(sample.slice(timerStart, timerEnd), /sourceFor/);
});

test("summary validation rejects an incomplete or misleading matrix", () => {
  assert.throws(() =>
    validateSummary({
      schemaVersion: 2,
      measurementScope: "end-to-end",
      scenarios: [],
    }),
  );
});

test("summary validation rejects duplicate rows, warm undercounting, and inverted percentiles", () => {
  const valid = JSON.parse(
    fs.readFileSync(new URL("./query-grid-summary.json", import.meta.url), "utf8"),
  );
  valid.scenarios[1].rows = valid.scenarios[0].rows;
  valid.scenarios[1].temperature = valid.scenarios[0].temperature;
  assert.throws(() => validateSummary(valid));
});

test("summary validation rejects latency, RSS, and materialized-baseline regressions", () => {
  const read = () =>
    JSON.parse(
      fs.readFileSync(new URL("./query-grid-summary.json", import.meta.url), "utf8"),
    );
  const slow = read();
  slow.scenarios[0].reactHappyDomCommitMs.p95 =
    slow.thresholds.maxReactHappyDomCommitP95Ms + 1;
  assert.throws(() => validateSummary(slow));
  const hungry = read();
  hungry.scenarios[0].reactCommitRssDeltaBytes.p95 =
    hungry.thresholds.maxReactCommitRssDeltaP95Bytes + 1;
  assert.throws(() => validateSummary(hungry));
  const materialized = read();
  materialized.scenarios[0].peakDomNodeCount =
    materialized.scenarios[0].materializedBaselineCellCount;
  materialized.scenarios[0].virtualDomToMaterializedCellRatio = 1;
  assert.throws(() => validateSummary(materialized));
});

test("absolute budgets reject uniformly scaled timing and RSS evidence", () => {
  const scaled = JSON.parse(
    fs.readFileSync(new URL("./query-grid-summary.json", import.meta.url), "utf8"),
  );
  for (const scenario of scaled.scenarios)
    for (const metric of [
      scenario.reactHappyDomCommitMs,
      scenario.reactCommitRssDeltaBytes,
    ])
      for (const key of ["p50", "p95"]) metric[key] *= 1_000;
  assert.throws(() => validateSummary(scaled));
});

test("summary validation rejects unknown fields and result payloads", () => {
  const read = () =>
    JSON.parse(
      fs.readFileSync(new URL("./query-grid-summary.json", import.meta.url), "utf8"),
    );
  const mutations = [
    (summary) => {
      summary.sql = "select secret from private_table";
    },
    (summary) => {
      summary.credentials = { token: "secret" };
    },
    (summary) => {
      summary.environment.hostname = "private-host";
    },
    (summary) => {
      summary.evidence.resultValues = ["secret"];
    },
    (summary) => {
      summary.thresholds.internalBudgetNotes = "secret";
    },
    (summary) => {
      summary.scenarios[0].resultRows = [["secret"]];
    },
    (summary) => {
      summary.scenarios[0].rowsPayload = [["secret"]];
    },
    (summary) => {
      summary.scenarios[0].rows = [["secret"]];
    },
    (summary) => {
      summary.scenarios[0].reactHappyDomCommitMs.samples = [1];
    },
    (summary) => {
      summary.scenarios[0].reactCommitRssDeltaBytes.samples = [1];
    },
  ];

  for (const mutate of mutations) {
    const summary = read();
    mutate(summary);
    assert.throws(() => validateSummary(summary));
  }
});
