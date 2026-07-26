// Executes and validates the real React/happy-dom query-grid benchmark artifact.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const output = path.join(here, "query-grid-summary.json");
const scope =
  "Frontend React 19 commit-only snapshots in happy-dom with prebuilt retained chunked query rows. Row construction is excluded from the timer; RSS is a per-sample post-minus-pre commit delta after source allocation. Separately correlate with src-tauri/benchmarks/desktop-streaming-summary.json and scripts/perf/query-runtime-profile.json. Excludes browser layout/paint and does not claim an automated Tauri/WebView click-to-interactive measurement.";
const rows = [1_000, 10_000, 50_000];
const temperatures = ["cold", "warm"];
const sampleCount = 20;
const exactMatrix = rows.flatMap((row) =>
  temperatures.map((temperature) => `${row}:${temperature}`),
);

function requireExactKeys(value, expectedKeys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expectedKeys].sort())
  )
    throw new Error(`invalid ${label} fields`);
}

export function nearestRank(values, percentile) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    percentile <= 0 ||
    percentile > 1
  )
    throw new Error("invalid percentile input");
  return [...values].sort((left, right) => left - right)[
    Math.ceil(percentile * values.length) - 1
  ];
}

export function validateSummary(summary) {
  requireExactKeys(
    summary,
    [
      "schemaVersion",
      "measurementScope",
      "methodology",
      "environment",
      "evidence",
      "thresholds",
      "scenarios",
    ],
    "query-grid summary",
  );
  requireExactKeys(
    summary.environment,
    ["platform", "arch", "node"],
    "query-grid environment",
  );
  requireExactKeys(
    summary.evidence,
    [
      "exactMatrix",
      "timedRegion",
      "rssIsolation",
      "runtimeProfileArtifact",
    ],
    "query-grid evidence",
  );
  requireExactKeys(
    summary.thresholds,
    [
      "budgetVersion",
      "maxDomNodes",
      "completeMatrix",
      "columns",
      "maxReactHappyDomCommitP95Ms",
      "maxReactCommitRssDeltaP95Bytes",
      "maxVirtualDomCellsFraction",
    ],
    "query-grid thresholds",
  );
  if (
    summary.schemaVersion !== 4 ||
    summary.measurementScope !== scope ||
    summary.scenarios?.length !== rows.length * temperatures.length ||
    summary.thresholds.budgetVersion !== 1 ||
    summary.thresholds.maxDomNodes !== 400 ||
    summary.thresholds.completeMatrix !== true ||
    summary.thresholds.columns !== 24 ||
    summary.thresholds.maxReactHappyDomCommitP95Ms !== 100 ||
    summary.thresholds.maxReactCommitRssDeltaP95Bytes !== 64 * 1024 * 1024 ||
    summary.thresholds.maxVirtualDomCellsFraction !== 0.02 ||
    JSON.stringify(summary.evidence.exactMatrix) !==
      JSON.stringify(exactMatrix) ||
    summary.evidence.timedRegion !==
      "performance.now immediately before act(root.render), ending immediately after act resolves" ||
    summary.evidence.rssIsolation !==
      "fresh DOM root and per-sample RSS baseline after measured and retained warm sources are allocated" ||
    summary.evidence.runtimeProfileArtifact !==
      "scripts/perf/query-runtime-profile.json" ||
    typeof summary.environment.platform !== "string" ||
    typeof summary.environment.arch !== "string" ||
    typeof summary.environment.node !== "string" ||
    !summary.methodology?.includes("nearest-rank ceil(p*N)") ||
    !summary.methodology?.includes("no SQL or result values")
  )
    throw new Error("invalid query-grid summary");
  const expected = new Set(
    rows.flatMap((row) => temperatures.map((temperature) => `${row}:${temperature}`)),
  );
  const seen = new Set();
  for (const scenario of summary.scenarios) {
    requireExactKeys(
      scenario,
      [
        "rows",
        "temperature",
        "sampleCount",
        "reactHappyDomCommitMs",
        "reactCommitRssDeltaBytes",
        "peakRowsHeld",
        "peakDomNodeCount",
        "materializedBaselineCellCount",
        "virtualDomToMaterializedCellRatio",
      ],
      "query-grid scenario",
    );
    requireExactKeys(
      scenario.reactHappyDomCommitMs,
      ["p50", "p95"],
      "query-grid React commit metric",
    );
    requireExactKeys(
      scenario.reactCommitRssDeltaBytes,
      ["p50", "p95"],
      "query-grid RSS delta metric",
    );
    const key = `${scenario.rows}:${scenario.temperature}`;
    if (!expected.has(key) || seen.has(key))
      throw new Error("query-grid scenario matrix is missing or duplicated");
    seen.add(key);
    if (
      scenario.sampleCount !== sampleCount ||
      scenario.peakDomNodeCount > 400 ||
      scenario.peakRowsHeld !== scenario.rows * (scenario.temperature === "warm" ? 2 : 1) ||
      scenario.materializedBaselineCellCount !== scenario.rows * 24 ||
      scenario.virtualDomToMaterializedCellRatio !==
        scenario.peakDomNodeCount / scenario.materializedBaselineCellCount ||
      scenario.virtualDomToMaterializedCellRatio >
        summary.thresholds.maxVirtualDomCellsFraction
    )
      throw new Error("query-grid structural threshold failed");
    for (const metric of [
      scenario.reactHappyDomCommitMs,
      scenario.reactCommitRssDeltaBytes,
    ])
      for (const value of Object.values(metric))
        if (!Number.isFinite(value) || value < 0)
          throw new Error("invalid query-grid metric");
    if (
      scenario.reactHappyDomCommitMs.p50 > scenario.reactHappyDomCommitMs.p95 ||
      scenario.reactCommitRssDeltaBytes.p50 >
        scenario.reactCommitRssDeltaBytes.p95 ||
      scenario.reactHappyDomCommitMs.p95 >
        summary.thresholds.maxReactHappyDomCommitP95Ms ||
      scenario.reactCommitRssDeltaBytes.p95 >
        summary.thresholds.maxReactCommitRssDeltaP95Bytes ||
      scenario.processRssBytes !== undefined
    )
      throw new Error("query-grid absolute or percentile threshold failed");
  }
  if (seen.size !== expected.size) throw new Error("incomplete query-grid matrix");
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint && process.argv[2] === "--check")
  validateSummary(JSON.parse(fs.readFileSync(output, "utf8")));
else if (isEntrypoint) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    command,
    ["vitest", "run", "src/components/DataGridVirtual.perf.test.tsx"],
    {
      cwd: path.resolve(here, "../.."),
      env: {
        ...process.env,
        QUERY_GRID_PERF: "1",
        QUERY_GRID_PERF_OUTPUT: output,
      },
      stdio: "inherit",
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  validateSummary(JSON.parse(fs.readFileSync(output, "utf8")));
}
