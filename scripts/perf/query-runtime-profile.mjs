// Validates or records aggregate Tauri desktop query interaction timings.
// Input accepts durations only; SQL text, row values, connection data, and
// credentials have no field in either the input or checked-in artifact.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const runtimeProfilePath = path.join(
  here,
  "query-runtime-profile.json",
);
const scope =
  "Tauri desktop click-to-first-batch and click-to-first-React-interactive measures emitted by production Performance marks. Aggregate durations only; no query text, rows, connection identifiers, or credentials.";
const marks = [
  "desktop_query_interaction_start",
  "desktop_query_stream_first_batch_received",
  "desktop_query_stream_react_commit",
];
const measures = [
  "desktop_query_interaction_to_first_batch",
  "desktop_query_interaction_to_react_interactive",
];
const minimumSamples = 10;
const budgets = {
  budgetVersion: 1,
  maxClickToFirstBatchP95Ms: 5_000,
  maxClickToReactInteractiveP95Ms: 5_000,
};
const unverifiedReason =
  "Repository automation has no configured Tauri desktop database target, so native Channel/WebView interaction timing has not been executed.";
const instrumentationOwners = {
  "src/screens/Sql/index.tsx": ["desktop_query_interaction_start"],
  "src/features/queries/tauriAdapter.ts": [
    "desktop_query_stream_first_batch_received",
  ],
  "src/features/queries/useSqlResultStream.ts": [
    "desktop_query_stream_react_commit",
    ...measures,
  ],
};

function exactKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  )
    throw new Error(`invalid ${label} fields`);
}

function nearestRank(values, percentile) {
  return [...values].sort((left, right) => left - right)[
    Math.ceil(percentile * values.length) - 1
  ];
}

const baseArtifact = {
  schemaVersion: 1,
  measurementScope: scope,
  verificationStatus: "instrumented_not_executed",
  unverifiedReason,
  instrumentation: { marks, measures },
  reproduction: {
    minimumSamples,
    snippetCommand: "node scripts/perf/query-runtime-profile.mjs --snippet",
    recordCommand:
      "node scripts/perf/query-runtime-profile.mjs --record <duration-input.json>",
    steps: [
      "Start the desktop app with pnpm dev:app and open its WebView developer tools.",
      "Run at least 10 row-producing read interactions against a configured local test connection.",
      "Run the snippet command, paste its output into the WebView console, and save the emitted duration-only JSON.",
      "Run the record command with that JSON, then run pnpm check:query-grid.",
    ],
  },
  budgets,
  sampleCount: 0,
  metrics: null,
};

export function buildMeasuredRuntimeProfile(input) {
  exactKeys(input, ["samples"], "runtime profile input");
  if (
    !Array.isArray(input.samples) ||
    input.samples.length < minimumSamples ||
    input.samples.length > 200
  )
    throw new Error(`runtime profile requires ${minimumSamples}-200 samples`);
  for (const sample of input.samples) {
    exactKeys(
      sample,
      ["interactionToFirstBatchMs", "interactionToReactInteractiveMs"],
      "runtime profile sample",
    );
    if (
      !Number.isFinite(sample.interactionToFirstBatchMs) ||
      !Number.isFinite(sample.interactionToReactInteractiveMs) ||
      sample.interactionToFirstBatchMs < 0 ||
      sample.interactionToReactInteractiveMs <
        sample.interactionToFirstBatchMs
    )
      throw new Error("invalid runtime profile duration");
  }
  const aggregate = (key) => {
    const values = input.samples.map((sample) => sample[key]);
    return {
      p50: nearestRank(values, 0.5),
      p95: nearestRank(values, 0.95),
    };
  };
  return {
    ...baseArtifact,
    verificationStatus: "measured",
    unverifiedReason: null,
    sampleCount: input.samples.length,
    metrics: {
      clickToFirstBatchMs: aggregate("interactionToFirstBatchMs"),
      clickToReactInteractiveMs: aggregate(
        "interactionToReactInteractiveMs",
      ),
    },
  };
}

export function validateRuntimeProfile(profile) {
  exactKeys(
    profile,
    [
      "schemaVersion",
      "measurementScope",
      "verificationStatus",
      "unverifiedReason",
      "instrumentation",
      "reproduction",
      "budgets",
      "sampleCount",
      "metrics",
    ],
    "runtime profile artifact",
  );
  exactKeys(profile.instrumentation, ["marks", "measures"], "instrumentation");
  exactKeys(
    profile.reproduction,
    ["minimumSamples", "snippetCommand", "recordCommand", "steps"],
    "reproduction",
  );
  exactKeys(
    profile.budgets,
    [
      "budgetVersion",
      "maxClickToFirstBatchP95Ms",
      "maxClickToReactInteractiveP95Ms",
    ],
    "runtime budgets",
  );
  if (
    profile.schemaVersion !== 1 ||
    profile.measurementScope !== scope ||
    JSON.stringify(profile.instrumentation.marks) !== JSON.stringify(marks) ||
    JSON.stringify(profile.instrumentation.measures) !==
      JSON.stringify(measures) ||
    profile.reproduction.minimumSamples !== minimumSamples ||
    profile.reproduction.snippetCommand !==
      baseArtifact.reproduction.snippetCommand ||
    profile.reproduction.recordCommand !==
      baseArtifact.reproduction.recordCommand ||
    JSON.stringify(profile.reproduction.steps) !==
      JSON.stringify(baseArtifact.reproduction.steps) ||
    JSON.stringify(profile.budgets) !== JSON.stringify(budgets)
  )
    throw new Error("invalid runtime profile contract");
  if (profile.verificationStatus === "instrumented_not_executed") {
    if (
      profile.unverifiedReason !== unverifiedReason ||
      profile.sampleCount !== 0 ||
      profile.metrics !== null
    )
      throw new Error("unverified runtime profile overclaims evidence");
    return;
  }
  if (
    profile.verificationStatus !== "measured" ||
    profile.unverifiedReason !== null ||
    profile.sampleCount < minimumSamples ||
    profile.sampleCount > 200
  )
    throw new Error("invalid measured runtime profile");
  exactKeys(
    profile.metrics,
    ["clickToFirstBatchMs", "clickToReactInteractiveMs"],
    "runtime metrics",
  );
  for (const metric of Object.values(profile.metrics)) {
    exactKeys(metric, ["p50", "p95"], "runtime percentile");
    if (
      !Number.isFinite(metric.p50) ||
      !Number.isFinite(metric.p95) ||
      metric.p50 < 0 ||
      metric.p50 > metric.p95
    )
      throw new Error("invalid runtime percentile");
  }
  if (
    profile.metrics.clickToFirstBatchMs.p95 >
      budgets.maxClickToFirstBatchP95Ms ||
    profile.metrics.clickToReactInteractiveMs.p95 >
      budgets.maxClickToReactInteractiveP95Ms
  )
    throw new Error("runtime interaction absolute budget exceeded");
}

export function validateRuntimeInstrumentation() {
  const root = path.resolve(here, "../..");
  for (const [relativePath, names] of Object.entries(instrumentationOwners)) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    for (const name of names)
      if (!source.includes(`"${name}"`))
        throw new Error(`${relativePath} is missing runtime mark ${name}`);
  }
}

const snippet = `(() => {
  const first = performance.getEntriesByName("${measures[0]}");
  const interactive = performance.getEntriesByName("${measures[1]}");
  if (first.length !== interactive.length) throw new Error("query measure counts differ");
  console.log(JSON.stringify({samples:first.map((entry,index)=>({
    interactionToFirstBatchMs:entry.duration,
    interactionToReactInteractiveMs:interactive[index].duration
  }))}));
})()`;

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint && process.argv[2] === "--check") {
  validateRuntimeProfile(
    JSON.parse(fs.readFileSync(runtimeProfilePath, "utf8")),
  );
  validateRuntimeInstrumentation();
} else if (isEntrypoint && process.argv[2] === "--snippet") {
  process.stdout.write(`${snippet}\n`);
} else if (isEntrypoint && process.argv[2] === "--record") {
  const inputPath = process.argv[3];
  if (!inputPath) throw new Error("--record requires a duration input path");
  const artifact = buildMeasuredRuntimeProfile(
    JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8")),
  );
  validateRuntimeProfile(artifact);
  fs.writeFileSync(runtimeProfilePath, `${JSON.stringify(artifact, null, 2)}\n`);
} else if (isEntrypoint) {
  throw new Error("use --check, --snippet, or --record <duration-input.json>");
}
