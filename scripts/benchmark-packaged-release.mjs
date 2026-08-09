import { execFile, execFileSync, spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");
const prefix = "dopedb-packaged-benchmark-";
const marker = "DOPEDB_PACKAGED_BENCHMARK:";
const fixtureMarker = "DOPEDB_PACKAGED_BENCHMARK_FIXTURE:";
const failureMarker = "DOPEDB_PACKAGED_BENCHMARK_FAILURE:";
const progressMarker = "DOPEDB_PACKAGED_BENCHMARK_PROGRESS:";
const activeChildren = new Set();
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  for (const child of activeChildren) child.kill("SIGTERM");
});
const connections = [0, 5, 20];
const workloadScenarios = [
  "sql-editor",
  "explorer-search",
  "query-result",
  "table-first-row",
  "agent-transcript",
  "agent-tools",
  "long-lived-data",
  "interaction-surfaces",
  "idle-runtime",
];
const requiredActionsByScenario = {
  "sql-editor": [
    "sql-editor-10k-type", "sql-editor-10k-cursor", "sql-editor-10k-format", "sql-editor-10k-run",
    "sql-editor-100k-type", "sql-editor-100k-cursor", "sql-editor-100k-format", "sql-editor-100k-run",
    "sql-editor-1m-type", "sql-editor-1m-cursor", "sql-editor-1m-format", "sql-editor-1m-run", "sql-editor-1m-scroll",
  ],
  "explorer-search": ["explorer-first-expand", "explorer-secondary-expand", "search-everywhere"],
  "query-result": ["query-first-batch", "query-grid-scroll-50k", "query-page-store-1m", "query-cancel", "query-export"],
  "table-first-row": ["table-first-page-cold", "table-first-page"],
  "agent-transcript": ["agent-stream-10k", "agent-manual-scroll", "agent-permission", "agent-reconnect"],
  "agent-tools": ["agent-skill-install-all", "agent-skill-reload", "agent-skill-remove-all"],
  "long-lived-data": ["history-10k", "audit-100k", "local-history-50", "dashboard-multi-tile"],
  "interaction-surfaces": [
    "erd-drag-1k",
    "grid-and-pane-resize",
    "workbench-scroll-continuity",
  ],
  "idle-runtime": [],
};
const nonVisualNativeActions = new Set([
  "query-page-store-1m",
  "query-cancel",
  "query-export",
  "agent-skill-reload",
  "history-10k",
  "audit-100k",
  "local-history-50",
  "dashboard-multi-tile",
]);
const options = parseArguments(process.argv.slice(2));
const budgets = JSON.parse(
  await readFile(
    join(root, "src-tauri/benchmarks/packaged-release-budgets.json"),
    "utf8",
  ),
);
if (
  budgets.schemaVersion !== 2
  || budgets.measurementScope !== "packaged_release_user_journeys"
) {
  throw new Error("packaged benchmark budgets use an unsupported schema");
}
const sampleCount = options.samples ?? budgets.sampleCountPerState;
const workloadSampleCount = options.workloadSamples
  ?? budgets.workloadSampleCountPerScenario;

if (!options.skipBuild) await buildPackagedBenchmark();
const executable = await packagedExecutable();
const temporaryRoot = await mkdtemp(join(tmpdir(), prefix));
const samples = [];
const standardFixtures = new Map();

try {
  if (options.only === null || options.only === "startup") {
    for (const connectionCount of connections) {
      const fixture = await prepareFixture(
        executable,
        temporaryRoot,
        connectionCount,
        "standard",
      );
      standardFixtures.set(connectionCount, fixture);
      const warmupRoot = join(temporaryRoot, `warmup-${connectionCount}`);
      await cloneFixture(fixture, warmupRoot);
      await runMeasuredApp(
        executable,
        warmupRoot,
        `connections-${connectionCount}-warmup`,
        connectionCount,
      );

      for (let index = 1; index <= sampleCount; index += 1) {
        const runRoot = join(temporaryRoot, `run-${connectionCount}-${index}`);
        await cloneFixture(fixture, runRoot);
        samples.push(await runMeasuredApp(
          executable,
          runRoot,
          `connections-${connectionCount}-cold-sample-${index}`,
          connectionCount,
        ));
        samples.push(await runMeasuredApp(
          executable,
          runRoot,
          `connections-${connectionCount}-warm-sample-${index}`,
          connectionCount,
        ));
      }
    }

    const recoveryFixture = await prepareFixture(
      executable,
      temporaryRoot,
      20,
      "recovery",
    );
    const recoveryWarmupRoot = join(temporaryRoot, "warmup-recovery");
    await cloneFixture(recoveryFixture, recoveryWarmupRoot);
    await runMeasuredApp(
      executable,
      recoveryWarmupRoot,
      "connections-20-recovery-warmup",
      20,
    );
    for (let index = 1; index <= sampleCount; index += 1) {
      const runRoot = join(temporaryRoot, `run-recovery-${index}`);
      await cloneFixture(recoveryFixture, runRoot);
      samples.push(await runMeasuredApp(
        executable,
        runRoot,
        `connections-20-recovery-cold-sample-${index}`,
        20,
      ));
      samples.push(await runMeasuredApp(
        executable,
        runRoot,
        `connections-20-recovery-warm-sample-${index}`,
        20,
      ));
    }
  }

  const selectedWorkloads = options.only === null
    ? workloadScenarios
    : options.only === "startup"
      ? []
      : [options.only];
  if (selectedWorkloads.length > 0) {
    let workloadFixture = standardFixtures.get(20);
    if (!workloadFixture) {
      workloadFixture = await prepareFixture(
        executable,
        temporaryRoot,
        20,
        "standard",
      );
      standardFixtures.set(20, workloadFixture);
    }
    const longLivedFixture = selectedWorkloads.includes("long-lived-data")
      ? await prepareFixture(
        executable,
        temporaryRoot,
        20,
        "long-lived",
      )
      : null;
    const tableDataFixture = selectedWorkloads.includes("table-first-row")
      ? await prepareFixture(
        executable,
        temporaryRoot,
        20,
        "table-data",
      )
      : null;
    for (const scenario of selectedWorkloads) {
      const fixture = scenario === "long-lived-data"
        ? longLivedFixture
        : scenario === "table-first-row"
          ? tableDataFixture
          : workloadFixture;
      if (!fixture) throw new Error("workload fixture is unavailable");
      const warmupRoot = join(temporaryRoot, `warmup-workload-${scenario}`);
      await cloneFixture(fixture, warmupRoot);
      if (scenario === "agent-tools") {
        await runMeasuredApp(executable, warmupRoot, scenario, 20, "install");
        await runMeasuredApp(executable, warmupRoot, scenario, 20, "restart");
      } else {
        await runMeasuredApp(executable, warmupRoot, scenario, 20);
      }
      for (let index = 1; index <= workloadSampleCount; index += 1) {
        const runRoot = join(temporaryRoot, `run-workload-${scenario}-${index}`);
        await cloneFixture(fixture, runRoot);
        if (scenario === "agent-tools") {
          samples.push(
            await runMeasuredApp(executable, runRoot, scenario, 20, "install"),
          );
          samples.push(
            await runMeasuredApp(executable, runRoot, scenario, 20, "restart"),
          );
        } else {
          samples.push(await runMeasuredApp(executable, runRoot, scenario, 20));
        }
      }
    }
  }

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const summary = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    measurementScope: "packaged_release_user_journeys",
    build: {
      profile: "release",
      application: "DopeDB Benchmark",
      appVersion: packageJson.version,
      commit: commandText("git", ["rev-parse", "HEAD"]),
      dirty: commandText("git", ["status", "--porcelain"]).length > 0,
    },
    environment: {
      os: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      node: process.version,
      webviews: uniqueWebviews(samples),
    },
    methodology: {
      diagnosticSelection: options.only,
      fixtureConnections: connections,
      sampleCountPerState: sampleCount,
      workloadSampleCountPerScenario: workloadSampleCount,
      warmupRunsPerFixture: budgets.warmupRunsPerFixture,
      fixtureScale: {
        sqlEditorBytes: [10 * 1024, 100 * 1024, 1024 * 1024],
        explorer: { connections: 20, databases: 50, objects: 5_000 },
        queryRows: { visible: 50_000, diskStore: 1_000_000 },
        agent: { elapsedMinutes: 10, events: 10_000 },
        agentTools: {
          targets: 2,
          lifecycle: ["install", "app-exit", "app-restart", "reload", "remove"],
        },
        longLived: { history: 10_000, audit: 100_000, revisions: 50, dashboardTiles: 8 },
        erdNodes: 1_000,
      },
      coldDefinition:
        "A fresh clone of a sealed migrated fixture is opened by a new packaged release process.",
      warmDefinition:
        "The same isolated fixture is reopened after the paired cold process exits cleanly.",
      observationWindow:
        "Renderer module load through first shell commit plus 1500 ms of visible post-paint recovery.",
      rss:
        "Maximum resident bytes sampled from the application process and its descendant process tree. Platform WebView helpers outside that tree are not claimed.",
      privacy:
        "Only closed stage names, numeric timings/counts, app/OS/WebView versions, and aggregate RSS are retained. IPC arguments/responses, SQL, rows, prompts, paths, credentials, and raw logs are never written to the artifact.",
    },
    budgets: { ...budgets.budgets, actionP95Ms: budgets.actionP95Ms },
    aggregates: {
      startup: aggregateStartupSamples(samples),
      actions: aggregateActions(samples),
      scenarios: aggregateScenarioResources(samples),
    },
    budgetEvaluation: evaluateBudgets(
      samples,
      budgets.budgets,
      budgets.actionP95Ms,
      selectedActionNames(options.only),
    ),
    samples,
  };
  const output = await prepareOutputPath(options.output);
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    output: relative(root, output),
    samples: samples.length,
    overall: summary.budgetEvaluation.overall,
    startupAggregates: summary.aggregates.startup,
    actionCount: Object.keys(summary.aggregates.actions).length,
  }, null, 2)}\n`);
  if (summary.budgetEvaluation.overall === "failed") process.exitCode = 1;
} finally {
  await removeOwnedTemporaryRoot(temporaryRoot);
}

function parseArguments(args) {
  const parsed = {
    skipBuild: false,
    samples: null,
    workloadSamples: null,
    only: null,
    output: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--skip-build") {
      parsed.skipBuild = true;
    } else if (argument === "--samples") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 20) {
        throw new Error("--samples must be an integer from 1 to 20");
      }
      parsed.samples = value;
    } else if (argument === "--workload-samples") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        throw new Error("--workload-samples must be an integer from 1 to 10");
      }
      parsed.workloadSamples = value;
    } else if (argument === "--output") {
      parsed.output = args[++index] ?? "";
      if (!parsed.output) throw new Error("--output requires a path");
    } else if (argument === "--only") {
      const value = args[++index] ?? "";
      if (value !== "startup" && !workloadScenarios.includes(value)) {
        throw new Error("--only must be startup or a workload scenario");
      }
      parsed.only = value;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  parsed.output ??= parsed.only === null
    ? "src-tauri/benchmarks/packaged-release-summary.json"
    : `src-tauri/benchmarks/packaged-release-${parsed.only}-diagnostic.json`;
  return parsed;
}

async function buildPackagedBenchmark() {
  const bundle = platform() === "darwin"
    ? "app"
    : platform() === "win32"
      ? "nsis"
      : "appimage";
  await runCommand(process.execPath, [
    tauriCli,
    "build",
    "--features",
    "packaged-benchmark",
    "--config",
    "src-tauri/tauri.benchmark.conf.json",
    "--bundles",
    bundle,
  ], { stdio: "inherit" });
}

async function packagedExecutable() {
  const path = platform() === "darwin"
    ? join(
        root,
        "target/release/bundle/macos/DopeDB Benchmark.app/Contents/MacOS/dopedb",
      )
    : platform() === "win32"
      ? join(root, "target/release/dopedb.exe")
      : join(root, "target/release/dopedb");
  if (!(await stat(path)).isFile()) throw new Error(`packaged executable missing: ${path}`);
  return path;
}

async function prepareFixture(executable, temporary, connectionCount, fixtureKind) {
  progress("prepare", `${fixtureKind}-${connectionCount}`);
  const fixture = join(temporary, `fixture-${fixtureKind}-${connectionCount}`);
  const data = join(fixture, "data");
  const home = join(fixture, "home");
  await mkdir(data, { recursive: true });
  await mkdir(home, { recursive: true });
  const result = await runApplication(executable, isolatedEnvironment(home, {
    DOPEDB_PACKAGED_BENCHMARK_DATA_DIR: data,
    DOPEDB_PACKAGED_BENCHMARK_HOME_DIR: home,
    DOPEDB_PACKAGED_BENCHMARK_PREPARE_CONNECTIONS: String(connectionCount),
    DOPEDB_PACKAGED_BENCHMARK_FIXTURE_KIND: fixtureKind,
  }), fixtureMarker, false, fixtureKind === "long-lived" ? 180_000 : 60_000);
  if (
    result.connectionCount !== connectionCount
    || result.fixtureKind !== fixtureKind
  ) {
    throw new Error("packaged fixture reported a different connection count");
  }
  return fixture;
}

async function cloneFixture(fixture, destination) {
  await mkdir(destination, { recursive: true });
  await cp(join(fixture, "data"), join(destination, "data"), { recursive: true });
  await cp(join(fixture, "home"), join(destination, "home"), { recursive: true });
}

async function runMeasuredApp(
  executable,
  runRoot,
  scenario,
  connectionCount,
  phase = null,
) {
  progress("run", phase === null ? scenario : `${scenario}-${phase}`);
  const started = performance.now();
  const home = join(runRoot, "home");
  const outcome = await runApplication(executable, isolatedEnvironment(home, {
    DOPEDB_PACKAGED_BENCHMARK_DATA_DIR: join(runRoot, "data"),
    DOPEDB_PACKAGED_BENCHMARK_HOME_DIR: home,
    DOPEDB_PACKAGED_BENCHMARK_SCENARIO: scenario,
    DOPEDB_PACKAGED_BENCHMARK_CONNECTIONS: String(connectionCount),
    ...(phase === null ? {} : { DOPEDB_PACKAGED_BENCHMARK_PHASE: phase }),
  }), marker, true, scenarioTimeoutMs(scenario));
  validateMeasuredOutcome(outcome, scenario, connectionCount, phase);
  const reportedProcessTreeRss = Number(outcome.report.processTreeRssBytes) || 0;
  return {
    scenario,
    ...(phase === null ? {} : { phase }),
    connectionCount,
    wallMs: round(performance.now() - started),
    maxProcessTreeRssBytes: Math.max(
      outcome.maxProcessTreeRssBytes,
      reportedProcessTreeRss,
    ),
    startup: outcome.report.startup,
    renderer: outcome.report.renderer,
  };
}

function validateMeasuredOutcome(outcome, scenario, connectionCount, phase = null) {
  const report = outcome?.report;
  const renderer = report?.renderer;
  const expectedActions = scenario === "agent-tools" && phase === "install"
    ? ["agent-skill-install-all"]
    : scenario === "agent-tools" && phase === "restart"
      ? ["agent-skill-reload", "agent-skill-remove-all"]
      : requiredActionsByScenario[scenario] ?? [];
  const reportedActions = renderer?.actions?.map((action) => action.name) ?? [];
  const uniqueActions = new Set(reportedActions);
  const missingActions = expectedActions.filter((action) => !uniqueActions.has(action));
  const hasDuplicateAction = uniqueActions.size !== reportedActions.length;
  const requiredPositiveCounts = [
    renderer?.reactCommitCount,
    renderer?.frameSampleCount,
    renderer?.ipcCallCount,
    Math.max(
      outcome?.maxProcessTreeRssBytes ?? 0,
      Number(report?.processTreeRssBytes) || 0,
    ),
  ];
  if (
    report?.schemaVersion !== 2
    || report?.measurementScope !== "packaged_release_user_journeys"
    || report?.scenario !== scenario
    || report?.connectionCount !== connectionCount
    || !Array.isArray(renderer?.actions)
    || missingActions.length > 0
    || hasDuplicateAction
    || renderer.actions.some(
      (action) => !Array.isArray(action.samplesMs) || action.samplesMs.length === 0,
    )
    || (scenario === "idle-runtime" && renderer.idleObservationMs < 9_000)
    || (scenario === "agent-tools" && renderer.idleObservationMs < 1_400)
    || !requiredPositiveCounts.every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    throw new Error(
      [
        "packaged benchmark returned incomplete or mismatched instrumentation",
        `react=${renderer?.reactCommitCount ?? "missing"}`,
        `frames=${renderer?.frameSampleCount ?? "missing"}`,
        `ipc=${renderer?.ipcCallCount ?? "missing"}`,
        `rss=${outcome?.maxProcessTreeRssBytes ?? "missing"}`,
        `missingActions=${missingActions.join(",") || "none"}`,
      ].join(" "),
    );
  }
}

function isolatedEnvironment(home, values) {
  return {
    ...values,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
    USER: "dopedb-benchmark",
    USERNAME: "dopedb-benchmark",
    LOGNAME: "dopedb-benchmark",
    ...(platform() === "win32" ? {} : { SHELL: "/bin/sh" }),
  };
}

function inheritedRuntimeEnvironment() {
  const allowed = [
    "PATH",
    "PATHEXT",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function runApplication(
  executable,
  environment,
  expectedMarker,
  sampleRss,
  timeoutMs,
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [], {
      cwd: dirname(executable),
      env: {
        ...inheritedRuntimeEnvironment(),
        ...environment,
        RUST_LOG: "dopedb::startup=info,error",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    let pending = "";
    let report = null;
    let maximumRss = 0;
    let timedOut = false;
    const observedStartupStages = new Set();
    let failureCategory = null;
    let failurePhase = null;
    let failureReason = null;
    const startupStageNames = [
      "store_ready",
      "operation_recovery",
      "provider_recovery",
      "window_shown",
      "first_shell_commit",
      "selected_connection_restored",
      "agent_session_recovery",
      "job_recovery",
      "broker_start",
    ];
    const inspect = (chunk) => {
      pending += chunk.toString("utf8");
      if (pending.length > 256 * 1024) pending = pending.slice(-128 * 1024);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        for (const stage of startupStageNames) {
          if (line.includes(`stage=${stage}`) || line.includes(`stage=\"${stage}\"`)) {
            observedStartupStages.add(stage);
          }
        }
        if (line.includes("failed to initialize app state")) {
          failureCategory = "state_initialization";
        } else if (line.includes("panicked at")) {
          failureCategory = "runtime_panic";
        }
        const failureOffset = line.indexOf(failureMarker);
        if (failureOffset >= 0) {
          const failure = parseBoundedMarker(
            line.slice(failureOffset + failureMarker.length),
          );
          if (failure === null) {
            failureCategory = "malformed_marker";
            child.kill("SIGTERM");
            continue;
          }
          failurePhase = failure?.phase ?? "unknown";
          failureReason = failure?.reason ?? "unknown";
          continue;
        }
        const progressOffset = line.indexOf(progressMarker);
        if (progressOffset >= 0) {
          const progressReport = parseBoundedMarker(
            line.slice(progressOffset + progressMarker.length),
          );
          if (
            progressReport === null
            || typeof progressReport.action !== "string"
            || !["start", "complete"].includes(progressReport.status)
          ) {
            failureCategory = "malformed_marker";
            child.kill("SIGTERM");
            continue;
          }
          progress("backend", `${progressReport.action}-${progressReport.status}`);
          continue;
        }
        const offset = line.indexOf(expectedMarker);
        if (offset < 0) continue;
        const candidate = parseBoundedMarker(
          line.slice(offset + expectedMarker.length),
        );
        if (candidate === null) {
          failureCategory = "malformed_marker";
          child.kill("SIGTERM");
          continue;
        }
        if (report !== null) {
          failureCategory = "duplicate_report";
          child.kill("SIGTERM");
          continue;
        }
        report = candidate;
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    let rssSamplePending = false;
    let latestRssSample = Promise.resolve();
    const sampleProcessTreeRss = () => {
      if (rssSamplePending) return;
      rssSamplePending = true;
      latestRssSample = processTreeRssBytes(child.pid)
        .then((rss) => {
          maximumRss = Math.max(maximumRss, rss);
        })
        .catch(() => undefined)
        .finally(() => {
          rssSamplePending = false;
        });
    };
    const usesNativeRssSampler = platform() === "win32" || platform() === "darwin";
    if (sampleRss && !usesNativeRssSampler) sampleProcessTreeRss();
    // macOS and Windows feature builds sample the exact process tree in-process.
    // Spawning `ps`/PowerShell during an interaction perturbs the frame clock the
    // benchmark is meant to measure, so the launcher only provides the fallback
    // sampler on platforms without native instrumentation.
    const sampler = sampleRss && !usesNativeRssSampler
      ? setInterval(sampleProcessTreeRss, 250)
      : null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", async (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(timeout);
      if (sampler !== null) clearInterval(sampler);
      await latestRssSample;
      if (pending) inspect("\n");
      if (interrupted) {
        reject(new Error("packaged benchmark interrupted"));
      } else if (timedOut) {
        reject(new Error([
          "packaged benchmark timed out",
          `stages=${[...observedStartupStages].join(",") || "none"}`,
          `failure=${failureCategory ?? "none"}`,
        ].join(" ")));
      } else if (failurePhase !== null) {
        reject(new Error(
          `packaged benchmark action failed phase=${failurePhase} reason=${failureReason}`,
        ));
      } else if (
        failureCategory === "malformed_marker"
        || failureCategory === "duplicate_report"
      ) {
        reject(new Error(`packaged benchmark emitted an invalid ${failureCategory}`));
      } else if (code !== 0 || signal !== null) {
        reject(new Error([
          `packaged benchmark exited code=${code} signal=${signal}`,
          `phase=${failurePhase ?? "unknown"}`,
        ].join(" ")));
      } else if (report === null) {
        reject(new Error("packaged benchmark did not emit its bounded report"));
      } else {
        resolvePromise(expectedMarker === marker
          ? { report, maxProcessTreeRssBytes: maximumRss }
          : report);
      }
    });
  });
}

function parseBoundedMarker(value) {
  if (value.length === 0 || value.length > 64 * 1024) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function scenarioTimeoutMs(scenario) {
  if (scenario === "query-result") return 360_000;
  if (scenario === "sql-editor") return 180_000;
  if (scenario === "idle-runtime") return 60_000;
  return 90_000;
}

async function processTreeRssBytes(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return 0;
  try {
    if (platform() === "win32") {
      const script = `(Get-Process -Id ${rootPid} -ErrorAction Stop).WorkingSet64`;
      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 2_000, windowsHide: true },
      );
      return Number(stdout.trim()) || 0;
    }
    const output = execFileSync(
      "ps",
      ["-axo", "pid=,ppid=,rss="],
      { encoding: "utf8", timeout: 2_000 },
    );
    const rows = output.trim().split(/\n+/).map((line) => {
      const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
      return { pid, ppid, rss };
    });
    const ids = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (ids.has(row.ppid) && !ids.has(row.pid)) {
          ids.add(row.pid);
          changed = true;
        }
      }
    }
    return rows
      .filter((row) => ids.has(row.pid))
      .reduce((total, row) => total + row.rss * 1024, 0);
  } catch {
    return 0;
  }
}

function aggregateStartupSamples(allSamples) {
  const startup = allSamples.filter((sample) => sample.scenario.startsWith("connections-"));
  const baseline = {};
  for (const connectionCount of connections) {
    for (const state of ["cold", "warm"]) {
      const selected = startup.filter((sample) =>
        sample.connectionCount === connectionCount
        && sample.scenario.includes(`-${state}-`)
        && !sample.scenario.includes("-recovery-")
      );
      baseline[`${connectionCount}-${state}`] = aggregateGroup(selected);
    }
  }
  const recovery = {};
  for (const state of ["cold", "warm"]) {
    recovery[`20-${state}`] = aggregateGroup(startup.filter((sample) =>
      sample.scenario.includes(`-recovery-${state}-`)
    ));
  }
  return { baseline, recovery };
}

function aggregateGroup(group) {
  return {
    samples: group.length,
    firstShellCommitP50Ms: percentile(group.map(firstShellCommit), 0.5),
    firstShellCommitP95Ms: percentile(group.map(firstShellCommit), 0.95),
    selectedConnectionRestoreP95Ms: percentile(
      group.map(selectedConnectionRestore).filter(Number.isFinite),
      0.95,
    ),
    storeReadyP95Ms: percentile(group.map((sample) => stageEnd(sample, "store_ready")), 0.95),
    maxFrameGapP95Ms: percentile(group.map((sample) => sample.renderer.maxFrameGapMs), 0.95),
    reactCommitDurationP95Ms: percentile(
      group.map((sample) => sample.renderer.maxReactCommitDurationMs),
      0.95,
    ),
    startupIpcCallsP50: percentile(group.map((sample) => sample.renderer.ipcCallCount), 0.5),
    startupIpcCallsP95: percentile(group.map((sample) => sample.renderer.ipcCallCount), 0.95),
    maxProcessTreeRssP95Bytes: percentile(
      group.map((sample) => sample.maxProcessTreeRssBytes),
      0.95,
    ),
  };
}

function actionMetricSamples(group, samplesKey, legacyKey) {
  return group.flatMap((action) => {
    const samples = action[samplesKey];
    if (Array.isArray(samples)) return samples.filter(Number.isFinite);
    const legacy = action[legacyKey];
    return Number.isFinite(legacy) ? [legacy] : [];
  });
}

function aggregateActions(allSamples) {
  const grouped = new Map();
  for (const sample of allSamples) {
    for (const action of sample.renderer.actions) {
      const group = grouped.get(action.name) ?? [];
      group.push(action);
      grouped.set(action.name, group);
    }
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([name, group]) => {
    const timings = group.flatMap((action) => action.samplesMs);
    const elapsedMs = sum(timings);
    const ipcCalls = sum(group.map((action) => action.ipcCallCount));
    const ipcPayloadBytes = sum(group.map((action) => action.ipcPayloadBytes));
    const sqliteTransactions = sum(
      group.map((action) => action.sqliteTransactionCount),
    );
    const backendRequestToFirstRow = actionMetricSamples(
      group,
      "backendRequestToFirstRowSamplesMs",
      "backendRequestToFirstRowMs",
    );
    const backendFirstRowToIpcBatch = actionMetricSamples(
      group,
      "backendFirstRowToIpcBatchSamplesMs",
      "backendFirstRowToIpcBatchMs",
    );
    const ipcBatchToReactCommit = actionMetricSamples(
      group,
      "ipcBatchToReactCommitSamplesMs",
      "ipcBatchToReactCommitMs",
    );
    const operationClaim = actionMetricSamples(
      group,
      "operationClaimSamplesMs",
      "operationClaimMs",
    );
    const poolConnectStart = actionMetricSamples(
      group,
      "poolConnectStartSamplesMs",
      "poolConnectStartMs",
    );
    const poolConnectReady = actionMetricSamples(
      group,
      "poolConnectReadySamplesMs",
      "poolConnectReadyMs",
    );
    const backendExecuteStart = actionMetricSamples(
      group,
      "backendExecuteStartSamplesMs",
      "backendExecuteStartMs",
    );
    const firstRow = actionMetricSamples(
      group,
      "firstRowSamplesMs",
      "firstRowMs",
    );
    const firstIpcBatch = actionMetricSamples(
      group,
      "firstIpcBatchSamplesMs",
      "firstIpcBatchMs",
    );
    return [name, {
      runs: group.length,
      samples: timings.length,
      actionToPaintP50Ms: percentile(timings, 0.5),
      actionToPaintP95Ms: percentile(timings, 0.95),
      reactCommitCount: sum(group.map((action) => action.reactCommitCount)),
      reactCommitDurationP95Ms: percentile(
        group.map((action) => action.reactCommitDurationMs),
        0.95,
      ),
      maxFrameGapP95Ms: percentile(
        group.map((action) => action.maxFrameGapMs),
        0.95,
      ),
      frameSampleCount: sum(group.map((action) => action.frameSampleCount)),
      droppedFrameCount: sum(group.map((action) => action.droppedFrameCount)),
      ipcCallCount: ipcCalls,
      ipcCallsPerSecond: rate(ipcCalls, elapsedMs),
      ipcDurationP95Ms: percentile(group.map((action) => action.ipcDurationMs), 0.95),
      ipcPayloadBytesMax: maximum(group.map((action) => action.ipcPayloadBytes)),
      ipcPayloadBytesPerSecond: rate(ipcPayloadBytes, elapsedMs),
      sqliteTransactionCount: sqliteTransactions,
      sqliteTransactionsPerSecond: rate(sqliteTransactions, elapsedMs),
      retainedBytesMax: maximum(group.map((action) => action.retainedBytes)),
      backendRequestToFirstRowP50Ms: percentile(
        backendRequestToFirstRow,
        0.5,
      ),
      backendRequestToFirstRowP95Ms: percentile(
        backendRequestToFirstRow,
        0.95,
      ),
      backendFirstRowToIpcBatchP50Ms: percentile(
        backendFirstRowToIpcBatch,
        0.5,
      ),
      backendFirstRowToIpcBatchP95Ms: percentile(
        backendFirstRowToIpcBatch,
        0.95,
      ),
      ipcBatchToReactCommitP50Ms: percentile(
        ipcBatchToReactCommit,
        0.5,
      ),
      ipcBatchToReactCommitP95Ms: percentile(
        ipcBatchToReactCommit,
        0.95,
      ),
      operationClaimP50Ms: percentile(
        operationClaim,
        0.5,
      ),
      operationClaimP95Ms: percentile(
        operationClaim,
        0.95,
      ),
      poolConnectStartP50Ms: percentile(
        poolConnectStart,
        0.5,
      ),
      poolConnectStartP95Ms: percentile(
        poolConnectStart,
        0.95,
      ),
      poolConnectReadyP50Ms: percentile(
        poolConnectReady,
        0.5,
      ),
      poolConnectReadyP95Ms: percentile(
        poolConnectReady,
        0.95,
      ),
      backendExecuteStartP50Ms: percentile(
        backendExecuteStart,
        0.5,
      ),
      backendExecuteStartP95Ms: percentile(
        backendExecuteStart,
        0.95,
      ),
      firstRowP50Ms: percentile(
        firstRow,
        0.5,
      ),
      firstRowP95Ms: percentile(
        firstRow,
        0.95,
      ),
      firstIpcBatchP50Ms: percentile(
        firstIpcBatch,
        0.5,
      ),
      firstIpcBatchP95Ms: percentile(
        firstIpcBatch,
        0.95,
      ),
    }];
  }));
}

function aggregateScenarioResources(allSamples) {
  return Object.fromEntries(workloadScenarios.map((scenario) => {
    const selected = allSamples.filter((sample) => sample.scenario === scenario);
    return [scenario, {
      runs: selected.length,
      maxProcessTreeRssP95Bytes: percentile(
        selected.map((sample) => sample.maxProcessTreeRssBytes),
        0.95,
      ),
      webviewHeapP95Bytes: percentile(
        selected.map((sample) => sample.renderer.webviewHeapBytes),
        0.95,
      ),
      maxFrameGapP95Ms: percentile(
        selected.map((sample) => sample.renderer.maxFrameGapMs),
        0.95,
      ),
      reactCommitDurationP95Ms: percentile(
        selected.map((sample) => sample.renderer.maxReactCommitDurationMs),
        0.95,
      ),
      ipcCallsPerSecondP95: percentile(
        selected.map((sample) => rate(
          sample.renderer.ipcCallCount,
          sample.renderer.rendererElapsedMs,
        )),
        0.95,
      ),
      idleIpcCallsPerMinuteP95: percentile(
        selected.map(idleIpcCallsPerMinute),
        0.95,
      ),
    }];
  }));
}

function evaluateBudgets(
  allSamples,
  limits,
  explicitActionLimits,
  expectedActions,
) {
  const startup = allSamples.filter((sample) => sample.scenario.startsWith("connections-"));
  const firstShell = percentile(startup.map(firstShellCommit), 0.95);
  const selectedRestore = percentile(
    startup.map(selectedConnectionRestore).filter(Number.isFinite),
    0.95,
  );
  const supportedLongTasks = allSamples.filter(
    (sample) => sample.renderer.longTaskSupported,
  );
  const actionAggregates = aggregateActions(allSamples);
  const actionChecks = {};
  for (const expected of expectedActions) {
    const aggregate = actionAggregates[expected];
    const budget = explicitActionLimits[expected] ?? limits.interactionP95Ms;
    actionChecks[expected] = aggregate
      ? verdict(aggregate.actionToPaintP95Ms, budget)
      : { status: "missing", measured: null, budget };
  }
  const requiredActionCount = Object.keys(actionChecks).length;
  const measuredActionCount = Object.values(actionChecks).filter(
    (check) => check.status !== "missing",
  ).length;
  const idleRate = percentile(
    allSamples
      .filter((sample) => sample.renderer.idleObservationMs > 0)
      .map(idleIpcCallsPerMinute),
    0.95,
  );
  const heapSamples = allSamples
    .map((sample) => sample.renderer.webviewHeapBytes)
    .filter(Number.isFinite);
  const activeFrameGaps = expectedActions
    .filter((action) => !nonVisualNativeActions.has(action))
    .map((action) => actionAggregates[action]?.maxFrameGapP95Ms)
    .filter(Number.isFinite);
  const startupFrameGaps = startup.map(
    (sample) => sample.renderer.maxFrameGapMs,
  );
  const checks = {
    firstShellCommitP95Ms: verdict(firstShell, limits.firstShellCommitP95Ms),
    selectedConnectionRestoreP95Ms: verdict(
      selectedRestore,
      limits.selectedConnectionRestoreP95Ms,
    ),
    maxMainThreadLongTaskMs: supportedLongTasks.length === allSamples.length
      ? verdict(
          Math.max(...supportedLongTasks.map((sample) => sample.renderer.maxLongTaskMs)),
          limits.maxMainThreadLongTaskMs,
        )
      : { status: "unsupported", measured: null, budget: limits.maxMainThreadLongTaskMs },
    maxFrameGapP95Ms: verdict(
      maximum([...startupFrameGaps, ...activeFrameGaps]),
      limits.maxFrameGapP95Ms,
    ),
    maxReactCommitDurationP95Ms: verdict(
      percentile(
        allSamples.map((sample) => sample.renderer.maxReactCommitDurationMs),
        0.95,
      ),
      limits.maxReactCommitDurationP95Ms,
    ),
    maxProcessRssP95Bytes: verdict(
      percentile(allSamples.map((sample) => sample.maxProcessTreeRssBytes), 0.95),
      limits.maxProcessRssP95Bytes,
    ),
    maxWebviewHeapBytes: heapSamples.length === allSamples.length
      ? verdict(maximum(heapSamples), limits.maxWebviewHeapBytes)
      : { status: "unsupported", measured: null, budget: limits.maxWebviewHeapBytes },
    requiredActionCoverage: {
      status: measuredActionCount === requiredActionCount ? "passed" : "failed",
      measured: measuredActionCount,
      budget: requiredActionCount,
    },
    idleIpcCallsPerMinute: verdict(idleRate, limits.idleIpcCallsPerMinute),
  };
  const statuses = [
    ...Object.values(checks).map((check) => check.status),
    ...Object.values(actionChecks).map((check) => check.status),
  ];
  return {
    overall: statuses.includes("failed")
      ? "failed"
      : statuses.every((status) => status === "passed")
        ? "passed"
        : "incomplete",
    checks,
    actionChecks,
  };
}

function selectedActionNames(only) {
  if (only === "startup") return [];
  if (only !== null) return requiredActionsByScenario[only];
  return Object.values(requiredActionsByScenario).flat();
}

function idleIpcCallsPerMinute(sample) {
  const elapsed = sample.renderer.idleObservationMs;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return Number.NaN;
  return (sample.renderer.idleIpcCallCount * 60_000) / elapsed;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function maximum(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.max(...finite) : null;
}

function rate(count, elapsedMs) {
  if (!Number.isFinite(count) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return null;
  }
  return round((count * 1_000) / elapsedMs);
}

function verdict(measured, budget) {
  if (!Number.isFinite(measured)) return { status: "missing", measured: null, budget };
  return { status: measured <= budget ? "passed" : "failed", measured, budget };
}

function firstShellCommit(sample) {
  return stageEnd(sample, "first_shell_commit");
}

function selectedConnectionRestore(sample) {
  return stageEnd(sample, "selected_connection_restored");
}

function stageEnd(sample, name) {
  const stage = sample.startup.stages.find((candidate) => candidate.name === name);
  return stage ? stage.startedMs + stage.durationMs : Number.NaN;
}

function percentile(values, fraction) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  return round(finite[Math.max(0, Math.ceil(finite.length * fraction) - 1)]);
}

function uniqueWebviews(allSamples) {
  return [...new Map(allSamples.map((sample) => {
    const identity = {
      engine: sample.renderer.webviewEngine,
      version: sample.renderer.webviewVersion,
    };
    return [`${identity.engine}:${identity.version}`, identity];
  })).values()];
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function progress(kind, value) {
  process.stdout.write(`[packaged-benchmark] ${kind}: ${value}\n`);
}

function commandText(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolvePromise();
      else reject(new Error(`${command} exited code=${code} signal=${signal}`));
    });
  });
}

function isWithin(base, path) {
  if (!isAbsolute(base) || !isAbsolute(path)) return false;
  const offset = relative(base, path);
  return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
}

async function prepareOutputPath(requested) {
  const output = resolve(root, requested);
  if (!isWithin(root, output)) {
    throw new Error("benchmark output must stay inside the repository");
  }
  await mkdir(dirname(output), { recursive: true });
  const canonicalRoot = await realpath(root);
  const canonicalParent = await realpath(dirname(output));
  const canonicalOutput = join(canonicalParent, basename(output));
  if (!isWithin(canonicalRoot, canonicalOutput)) {
    throw new Error("benchmark output parent must stay inside the repository");
  }
  try {
    const metadata = await lstat(canonicalOutput);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("benchmark output must be a regular file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return canonicalOutput;
}

async function removeOwnedTemporaryRoot(path) {
  const offset = relative(resolve(tmpdir()), resolve(path));
  if (
    offset.startsWith("..")
    || isAbsolute(offset)
    || !basename(path).startsWith(prefix)
  ) {
    throw new Error("refusing to remove a non-benchmark temporary root");
  }
  await rm(path, { recursive: true, force: true });
}
