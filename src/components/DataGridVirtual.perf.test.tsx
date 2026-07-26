// @vitest-environment happy-dom
// Regeneration-only React DOM benchmark. The checked-in artifact contains aggregates,
// never SQL text or row values; normal Vitest runs skip this expensive matrix.
// @ts-expect-error benchmark-only Node API; the browser application has no Node types.
import fs from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  appendSqlStreamRows,
  emptySqlStreamRows,
} from "../features/queries/domain";
import { I18nProvider } from "../lib/i18n";
import DataGridVirtual from "./DataGridVirtual";

declare const process: {
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
  version: string;
  memoryUsage(): { rss: number };
};

const output = process.env.QUERY_GRID_PERF_OUTPUT;
const shouldMeasure = process.env.QUERY_GRID_PERF === "1" && !!output;
const sampleCount = 20;
const rowCounts = [1_000, 10_000, 50_000];
const temperatures = ["cold", "warm"] as const;
const columns = Array.from({ length: 24 }, (_, index) => `c${index}`);

function nearestRank(values: number[], percentile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function sourceFor(rows: number) {
  let source = emptySqlStreamRows();
  for (let start = 0; start < rows; start += 256) {
    const batch = Array.from(
      { length: Math.min(256, rows - start) },
      (_, offset) =>
        Array.from({ length: columns.length }, () => start + offset),
    );
    source = appendSqlStreamRows(source, batch);
  }
  return source;
}

async function renderSample(rows: number, warm: boolean) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = async (source: ReturnType<typeof sourceFor>) => {
    await act(async () =>
      root.render(
        <I18nProvider>
          <DataGridVirtual
            result={{
              columns,
              rows: [],
              rowCount: rows,
              truncated: false,
              durationMs: 0,
            }}
            rowSource={source}
            startIndex={0}
          />
        </I18nProvider>,
      ),
    );
  };
  // Hold the warm source while rendering the measured source. This reports the
  // real retained-row peak rather than pretending the old cache vanished before
  // a replacement commit exists.
  const retainedWarmSource = warm ? sourceFor(rows) : null;
  if (retainedWarmSource) await render(retainedWarmSource);
  const measuredSource = sourceFor(rows);
  // Row generation and the warm replacement source are fully allocated before
  // both the commit timer and per-sample RSS baseline.
  const rssBeforeCommit = process.memoryUsage().rss;
  const started = performance.now();
  await render(measuredSource);
  const commitMs = performance.now() - started;
  const rssAfterCommit = process.memoryUsage().rss;
  const nodes = container.querySelectorAll("*").length;
  root.unmount();
  container.remove();
  return {
    commitMs,
    nodes,
    rowsHeld:
      measuredSource.rowCount + (retainedWarmSource?.rowCount ?? 0),
    rssDeltaBytes: Math.max(0, rssAfterCommit - rssBeforeCommit),
  };
}

describe("DataGridVirtual performance artifact", () => {
  it.skipIf(!shouldMeasure)(
    "measures React happy-dom commits for the complete matrix",
    async () => {
      const scenarios = [];
      for (const rows of rowCounts)
        for (const temperature of temperatures) {
          const samples = [];
          for (let sample = 0; sample < sampleCount; sample += 1)
            samples.push(await renderSample(rows, temperature === "warm"));
          expect(samples.every((entry) => entry.nodes < 400)).toBe(true);
          scenarios.push({
            rows,
            temperature,
            sampleCount,
            reactHappyDomCommitMs: {
              p50: nearestRank(
                samples.map((entry) => entry.commitMs),
                0.5,
              ),
              p95: nearestRank(
                samples.map((entry) => entry.commitMs),
                0.95,
              ),
            },
            reactCommitRssDeltaBytes: {
              p50: nearestRank(
                samples.map((entry) => entry.rssDeltaBytes),
                0.5,
              ),
              p95: nearestRank(
                samples.map((entry) => entry.rssDeltaBytes),
                0.95,
              ),
            },
            peakRowsHeld: Math.max(...samples.map((entry) => entry.rowsHeld)),
            peakDomNodeCount: Math.max(...samples.map((entry) => entry.nodes)),
            materializedBaselineCellCount: rows * columns.length,
            virtualDomToMaterializedCellRatio:
              Math.max(...samples.map((entry) => entry.nodes)) /
              (rows * columns.length),
          });
        }
      fs.writeFileSync(
        output!,
        `${JSON.stringify(
          {
            schemaVersion: 4,
            measurementScope:
              "Frontend React 19 commit-only snapshots in happy-dom with prebuilt retained chunked query rows. Row construction is excluded from the timer; RSS is a per-sample post-minus-pre commit delta after source allocation. Separately correlate with src-tauri/benchmarks/desktop-streaming-summary.json and scripts/perf/query-runtime-profile.json. Excludes browser layout/paint and does not claim an automated Tauri/WebView click-to-interactive measurement.",
            methodology:
              "20 repeated cold/warm commits per exact row-temperature case, each with a fresh DOM root; warm keeps old and new sources retained; sourceFor completes before performance.now and the RSS baseline; RSS delta may under-report allocator reuse; nearest-rank ceil(p*N) p50/p95; aggregates only, with no SQL or result values",
            environment: {
              platform: process.platform,
              arch: process.arch,
              node: process.version,
            },
            evidence: {
              exactMatrix: rowCounts.flatMap((rows) =>
                temperatures.map((temperature) => `${rows}:${temperature}`),
              ),
              timedRegion:
                "performance.now immediately before act(root.render), ending immediately after act resolves",
              rssIsolation:
                "fresh DOM root and per-sample RSS baseline after measured and retained warm sources are allocated",
              runtimeProfileArtifact:
                "scripts/perf/query-runtime-profile.json",
            },
            thresholds: {
              budgetVersion: 1,
              maxDomNodes: 400,
              completeMatrix: true,
              columns: columns.length,
              maxReactHappyDomCommitP95Ms: 100,
              maxReactCommitRssDeltaP95Bytes: 64 * 1024 * 1024,
              maxVirtualDomCellsFraction: 0.02,
            },
            scenarios,
          },
          null,
          2,
        )}\n`,
      );
    },
    120_000,
  );
});
