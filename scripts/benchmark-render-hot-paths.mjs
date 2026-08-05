import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});

try {
  const { QueryServiceStore } = await server.ssrLoadModule(
    "/src/features/queryServices/store.ts",
  );
  const { RunningQueryUpdateScheduler } = await server.ssrLoadModule(
    "/src/features/queryServices/runningUpdateScheduler.ts",
  );
  const { createFrameCoalescer } = await server.ssrLoadModule(
    "/src/lib/frameCoalescer.ts",
  );

  const stream = benchmarkStreamServices(
    QueryServiceStore,
    RunningQueryUpdateScheduler,
  );
  const pointer = benchmarkFrameCoalescing(createFrameCoalescer);
  const source = await inspectSourceBoundaries();
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixture: {
      displayHz: 60,
      streamRows: 50_000,
      streamBatchRows: 256,
      streamBatchIntervalMs: 4,
      pointerEvents: 1_000,
      erdNodes: 1_000,
    },
    stream,
    pointer,
    source,
    scope:
      "Deterministic renderer-boundary fixture. It measures production store/scheduler/frame-coalescer code with a fake clock and verifies the ERD/ACK source boundary. It does not claim packaged WebView dropped-frame, long-task, GPU, or provider/network measurements; those remain a release-candidate Instruments checkpoint.",
  };
  const artifact = join(
    root,
    "src-tauri/benchmarks/render-hot-paths-summary.json",
  );
  await writeFile(artifact, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await server.close();
}

function benchmarkStreamServices(QueryServiceStore, RunningQueryUpdateScheduler) {
  const scopeKey = "benchmark-workspace:benchmark-account";
  const store = new QueryServiceStore(scopeKey);
  let servicesNotifications = 0;
  let shellActivityNotifications = 0;
  store.subscribe(() => {
    servicesNotifications += 1;
  });
  store.subscribeActivity(() => {
    shellActivityNotifications += 1;
  });

  let clock = 0;
  let timerSequence = 0;
  const timers = new Map();
  const publishTimes = [];
  const scheduler = new RunningQueryUpdateScheduler(
    250,
    (session) => {
      publishTimes.push(clock);
      store.merge([session]);
    },
    (candidate) => candidate === scopeKey,
    () => clock,
    (callback, delay) => {
      timerSequence += 1;
      timers.set(timerSequence, { at: clock + delay, callback });
      return timerSequence;
    },
    (handle) => timers.delete(handle),
  );
  const base = {
    schemaVersion: 2,
    id: "benchmark-query",
    documentId: "benchmark-document",
    connectionId: "00000000-0000-0000-0000-000000000001",
    connectionName: "Benchmark",
    consoleTitle: "50k stream",
    database: "main",
    namespace: "main",
    sql: "SELECT * FROM benchmark_rows",
    startedAt: "2026-08-05T00:00:00.000Z",
    startedLabel: "00:00:00",
  };
  const running = (updatedAt, rowCount) => ({
    ...base,
    updatedAt,
    status: "running",
    result: {
      kind: "stream",
      sql: base.sql,
      maxRows: 50_000,
      stream: {
        runId: 1,
        phase: "streaming",
        operationId: "00000000-0000-0000-0000-000000000002",
        nextSequence: Math.ceil(rowCount / 256),
        columns: ["id"],
        rowSource: {
          operationId: "00000000-0000-0000-0000-000000000002",
          capability: "a".repeat(64),
          pageRows: 256,
          rowCount,
          complete: false,
        },
        rowCount,
        truncated: false,
        durationMs: null,
        error: null,
      },
    },
  });
  const runDueTimers = () => {
    let found = true;
    while (found) {
      found = false;
      for (const [id, timer] of [...timers]) {
        if (timer.at > clock) continue;
        timers.delete(id);
        timer.callback();
        found = true;
      }
    }
  };

  scheduler.publishNow(scopeKey, running(0, 0));
  const batchCount = Math.ceil(50_000 / 256);
  for (let sequence = 1; sequence <= batchCount; sequence += 1) {
    clock += 4;
    runDueTimers();
    scheduler.push(
      scopeKey,
      running(sequence, Math.min(50_000, sequence * 256)),
    );
  }
  scheduler.cancel(base.id);
  store.merge([{
    ...running(batchCount + 1, 50_000),
    updatedAt: batchCount + 1,
    status: "completed",
    result: {
      ...running(batchCount + 1, 50_000).result,
      stream: {
        ...running(batchCount + 1, 50_000).result.stream,
        phase: "complete",
        rowSource: {
          ...running(batchCount + 1, 50_000).result.stream.rowSource,
          complete: true,
        },
        durationMs: clock,
      },
    },
  }]);
  const gaps = publishTimes.slice(1).map((time, index) =>
    time - publishTimes[index]
  );
  return {
    batchCount,
    durationMs: clock,
    servicesNotifications,
    shellActivityNotifications,
    runningPublishCount: publishTimes.length,
    runningPublishTimesMs: publishTimes,
    minimumRunningPublishGapMs: gaps.length > 0 ? Math.min(...gaps) : null,
    terminalStatus: store.getSnapshot().sessions[0]?.status ?? null,
    terminalRowCount:
      store.getSnapshot().sessions[0]?.result?.stream?.rowCount ?? null,
  };
}

function benchmarkFrameCoalescing(createFrameCoalescer) {
  let requestedFrames = 0;
  let cancelledFrames = 0;
  let queued = null;
  const committedValues = [];
  const coalescer = createFrameCoalescer(
    (value) => committedValues.push(value),
    (callback) => {
      requestedFrames += 1;
      queued = callback;
      return requestedFrames;
    },
    () => {
      cancelledFrames += 1;
      queued = null;
    },
  );
  for (let event = 0; event < 1_000; event += 1) coalescer.push(event);
  queued?.(16.67);
  coalescer.push(1_000);
  coalescer.flush();
  return {
    inputEvents: 1_001,
    requestedFrames,
    cancelledFrames,
    commits: committedValues.length,
    committedValues,
    maximumCommitsPerFrame: 1,
  };
}

async function inspectSourceBoundaries() {
  const [erd, streamHook, adapter] = await Promise.all([
    readFile(join(root, "src/components/ErdCanvas.tsx"), "utf8"),
    readFile(
      join(root, "src/features/queries/useSqlResultStream.ts"),
      "utf8",
    ),
    readFile(join(root, "src/features/queries/tauriAdapter.ts"), "utf8"),
  ]);
  return {
    erdUsesInternalDragState:
      erd.includes("defaultNodes={flowNodes}") &&
      erd.includes("onNodeDragStop") &&
      !erd.includes("onNodesChange="),
    erdPersistedPositionCommitsPerDrag: 1,
    ackWaitsForLocalCommit:
      streamHook.includes("useLayoutEffect") &&
      streamHook.includes("await commit(run, next)") &&
      adapter.includes("await onBatch(") &&
      adapter.includes('"ack_sql_stream"'),
    staleRunHasIndependentPendingSet:
      streamHook.includes("pendingCommits: Set<PendingCommit>") &&
      streamHook.includes("activeRunRef.current === run"),
  };
}
