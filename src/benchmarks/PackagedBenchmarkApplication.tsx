import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { forceParsing } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";

import DataGrid from "../components/DataGrid";
import ErdCanvas from "../components/ErdCanvas";
import SqlViewer from "../components/SqlViewer";
import {
  AgentPermissionCard,
} from "../design-system/components/Agent";
import {
  AgentRichText,
  AgentStreamingText,
} from "../design-system/components/AgentRichText";
import {
  WorkbenchButton,
  WorkbenchScrollBody,
} from "../design-system/components/Workbench";
import { VirtualTreeRows, type VirtualTreeRow } from "../design-system/components/VirtualTreeRows";
import {
  indexSearchEverywhereItems,
  searchEverywhereItems,
  type SearchEverywhereItem,
} from "../features/actionSearch/domain";
import type {
  AcpConversationProjection,
  AcpTranscriptItem,
} from "../features/agents/transcript";
import {
  appendAcpConversationEvents,
  createAcpConversationProjection,
  mergeAcpConversationFocus,
  visibleAcpTranscriptItems,
} from "../features/agents/transcript";
import type {
  AcpSessionEvent,
  AcpSessionId,
} from "../features/agents/domain";
import { useToolWindowLayout } from "../features/appShell/useToolWindowLayout";
import { formatSqlDocument } from "../features/query/sqlFormatter";
import SkillStartupGate from "../features/skills/SkillStartupGate";
import { openAgentSetup } from "../features/skills/agentPreferences";
import { removeSkill, skillStatus } from "../features/skills/tauriAdapter";
import AgentToolsSettings from "../screens/Settings/AgentTools";
import type {
  CatalogSnapshot,
  QueryResult,
  SkillStatus,
  SkillTargetExpectation,
} from "../ipc/types";
import {
  completePackagedBenchmark,
  failPackagedBenchmark,
  preparePackagedBenchmarkWorkload,
  setPackagedBenchmarkCompactWindow,
  type PackagedBenchmarkFailureReason,
} from "../features/runtime/tauriAdapter";
import { runSqlReadPage } from "../features/queries/tauriAdapter";
import type { SqlStreamReceipt } from "../features/queries/domain";
import { useI18n } from "../lib/i18n";
import { messages } from "../lib/i18n/catalog";
import type { Lang } from "../lib/i18n/types";
import {
  measurePackagedAction,
  measurePackagedIdle,
  packagedRendererMetrics,
  currentPackagedAction,
  waitForPackagedPaint,
  type PackagedActionEvidence,
  type PackagedBenchmarkActionName,
} from "./packagedMetrics";
import {
  runPackagedBenchmarkBackend,
  type PackagedBackendAction,
  type PackagedBackendReceipt,
} from "./backend";

const ACTION_SAMPLES = 5;
const SQL_RICH_EDITING_MAX_BYTES = 256 * 1024;
const FIXTURE_CONNECTION_ID = "bed00000-0000-0000-0000-000000000001";
const DENSE_GRID_COLUMN_COUNT = 36;

export function PackagedBenchmarkApplication({
  scenario,
  phase,
}: {
  scenario: string;
  phase: "install" | "restart" | null;
}) {
  switch (scenario) {
    case "sql-editor":
      return <SqlEditorScenario />;
    case "explorer-search":
      return <ExplorerSearchScenario />;
    case "query-result":
      return <QueryResultScenario />;
    case "table-first-row":
      return <TableFirstRowScenario />;
    case "agent-transcript":
      return <AgentTranscriptScenario />;
    case "agent-tools":
      return <AgentToolsScenario phase={phase} />;
    case "long-lived-data":
      return <LongLivedDataScenario />;
    case "interaction-surfaces":
      return <InteractionSurfacesScenario />;
    case "idle-runtime":
      return <IdleRuntimeScenario />;
    default:
      return <BenchmarkFailure />;
  }
}

function BenchmarkFailure() {
  useEffect(() => {
    void finishBenchmark();
  }, []);
  return <BenchmarkSurface title="Unsupported benchmark scenario" />;
}

function BenchmarkSurface({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="tw:flex tw:h-screen tw:min-h-0 tw:w-screen tw:min-w-0 tw:flex-col tw:overflow-hidden tw:bg-background tw:text-foreground">
      <header className="tw:flex tw:h-control-lg tw:shrink-0 tw:items-center tw:border-b tw:border-border-subtle tw:bg-card tw:px-3 tw:text-sm tw:font-semibold">
        {title}
      </header>
      <div className="tw:flex tw:min-h-0 tw:min-w-0 tw:flex-1 tw:flex-col tw:overflow-hidden">
        {children}
      </div>
    </main>
  );
}

function useScenarioRunner(ready: boolean, runner: () => Promise<void>) {
  const started = useRef(false);
  const latest = useRef(runner);
  latest.current = runner;
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    void preparePackagedBenchmarkWorkload()
      .then(() => latest.current())
      .catch((error) =>
        failPackagedBenchmark(
          currentPackagedAction() ?? "scenario-setup",
          benchmarkFailureReason(error),
        )
      );
  }, [ready]);
}

function benchmarkFailureReason(error: unknown): PackagedBenchmarkFailureReason {
  if (error instanceof RangeError) return "range_error";
  if (error instanceof TypeError) return "type_error";
  if (!(error instanceof Error)) return "unexpected";
  if (error.message.includes("accessibility contract")) return "accessibility_contract";
  if (error.message.includes("viewport")) return "viewport_contract";
  if (error.message.includes("locale")) return "locale_contract";
  if (error.message.includes("keyboard")) return "keyboard_contract";
  if (error.message.includes("Skill inventory") || error.message.includes("Skill targets") || error.message.includes("Skill removal")) {
    return "skill_state";
  }
  if (error.message.includes("unavailable")) return "surface_unavailable";
  if (error.message.includes("timed out")) return "paint_timeout";
  if (error.message.includes("benchmark backend")) return "backend_command";
  return "unexpected";
}

async function finishBenchmark() {
  await completePackagedBenchmark(packagedRendererMetrics());
}

async function samples(
  name: PackagedBenchmarkActionName,
  count: number,
  action: (index: number) => void | PackagedActionEvidence | Promise<void | PackagedActionEvidence>,
) {
  for (let index = 0; index < count; index += 1) {
    await measurePackagedAction(name, () => action(index));
  }
}

function sqlFixture(bytes: number) {
  const statement = "select id, email from benchmark_users where active = true;\n";
  return statement.repeat(Math.ceil(bytes / statement.length)).slice(0, bytes);
}

function SqlEditorScenario() {
  const [value, setValue] = useState(() => sqlFixture(10 * 1024));
  const [view, setView] = useState<EditorView | null>(null);
  const [runCount, setRunCount] = useState(0);

  useScenarioRunner(view !== null, async () => {
    if (!view) return;
    const fixtures = [
      ["10k", 10 * 1024],
      ["100k", 100 * 1024],
      ["1m", 1024 * 1024],
    ] as const;

    for (const [label, size] of fixtures) {
      const source = sqlFixture(size);
      await setControlledSqlDocument(view, setValue, source);

      await samples(`sql-editor-${label}-type`, ACTION_SAMPLES, (index) => {
        const position = Math.max(0, view.state.doc.length - index);
        view.dispatch({ changes: { from: position, insert: " " } });
      });
      await settleSqlNavigationFixture(view, size);
      await samples(`sql-editor-${label}-cursor`, ACTION_SAMPLES, (index) => {
        const position = Math.floor(
          (view.state.doc.length * (index + 1)) / (ACTION_SAMPLES + 1),
        );
        view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
      });
      for (let index = 0; index < 2; index += 1) {
        await setControlledSqlDocument(view, setValue, source);
        await measurePackagedAction(`sql-editor-${label}-format`, async () => {
          const formatted = await formatSqlDocument(
            view.state.doc.toString(),
            "sqlite",
          );
          await setControlledSqlDocument(view, setValue, formatted);
        });
      }
      await samples(`sql-editor-${label}-run`, ACTION_SAMPLES, () => {
        view.contentDOM.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            metaKey: true,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      if (label === "1m") {
        await waitForPackagedPaint();
        const scroller = view.scrollDOM;
        if (scroller.scrollHeight <= scroller.clientHeight) {
          throw new Error("SQL editor scroll surface unavailable");
        }
        await samples("sql-editor-1m-scroll", ACTION_SAMPLES, (index) => {
          // The previous measured paint must not reset CodeMirror's viewport.
          // Checking it at the next sample keeps setup out of the interaction
          // budget while still proving repeated trackpad-style scrolling works.
          if (index > 0 && scroller.scrollTop <= 0) {
            throw new Error("SQL editor viewport did not preserve its scroll position");
          }
          scroller.scrollTop = 0;
          scroller.scrollTop = Math.max(240, scroller.clientHeight / 2);
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          if (scroller.scrollTop <= 0) {
            throw new Error("SQL editor viewport did not accept a scroll position");
          }
        });
      }
    }
    await finishBenchmark();
  });

  return (
    <BenchmarkSurface title={`SQL editor · ${value.length} bytes · runs ${runCount}`}>
      <div
        data-workbench-scroll-owner="sql-editor"
        className="tw:min-h-0 tw:flex-1 tw:overflow-hidden tw:bg-background tw:[&>.cm-theme-dark]:h-full tw:[&_.cm-editor]:h-full tw:[&_.cm-editor]:bg-background tw:[&_.cm-scroller]:min-h-0 tw:[&_.cm-scroller]:overflow-auto tw:[&_.cm-scroller]:overscroll-contain"
      >
        <SqlViewer
          value={value}
          editable
          engine="sqlite"
          minHeight="0px"
          onChange={setValue}
          onEditorReady={setView}
          onRun={() => setRunCount((count) => count + 1)}
        />
      </div>
    </BenchmarkSurface>
  );
}

async function settleSqlNavigationFixture(view: EditorView, bytes: number) {
  if (bytes <= SQL_RICH_EDITING_MAX_BYTES) {
    // Cursor movement measures navigation through a visible, ready document.
    // Finish CodeMirror's deliberately deferred Lezer work after the synthetic
    // typing samples so an idle parse is not attributed to the first cursor.
    forceParsing(view, view.state.doc.length, 1_000);
  }
  await waitForPackagedPaint();
}

async function setControlledSqlDocument(
  view: EditorView,
  setValue: (value: string) => void,
  value: string,
) {
  flushSync(() => setValue(value));
  const matches = () => {
    const document = view.state.doc;
    const edgeLength = Math.min(64, value.length);
    return document.length === value.length
      && document.sliceString(0, edgeLength) === value.slice(0, edgeLength)
      && document.sliceString(document.length - edgeLength) === value.slice(-edgeLength);
  };
  // @uiw/react-codemirror deliberately defers controlled value echoes while a
  // typing latch is active. Give the production path a bounded opportunity to
  // settle after the prop/extension commit.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await waitForPackagedPaint();
    if (matches()) return;
  }
  // Deterministic fixture fallback: rich-language extensions were already
  // reconfigured by the flushed prop commit, and fixture replacement must not
  // accumulate synthetic undo history across the 10KiB/100KiB/1MiB cases.
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
    selection: { anchor: 0 },
    annotations: Transaction.addToHistory.of(false),
  });
  await waitForPackagedPaint();
  if (!matches()) throw new Error("controlled SQL benchmark document did not settle");
}

function ExplorerSearchScenario() {
  const fixture = useMemo(explorerFixture, []);
  const [visibleCount, setVisibleCount] = useState(0);
  const [searchLabels, setSearchLabels] = useState<string[]>([]);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);

  useScenarioRunner(scrollElement !== null, async () => {
    // Measure actual first and secondary expansion once per fresh renderer.
    // Repeated collapse loops mix collection of the previous synthetic tree
    // into first-use latency; workload processes own the p50/p95 sample count.
    await measurePackagedAction("explorer-first-expand", () => {
      setVisibleCount(2_500);
    });
    await measurePackagedAction("explorer-secondary-expand", () => {
      setVisibleCount(5_000);
    });
    await samples("search-everywhere", 10, (index) => {
      const result = searchEverywhereItems(
        fixture.index,
        `object-${4_990 + index}`,
      );
      setSearchLabels(result.map((item) => item.label));
    });
    await finishBenchmark();
  });

  return (
    <BenchmarkSurface title="Explorer · 20 connections · 50 databases · 5,000 objects">
      <div className="tw:flex tw:min-h-0 tw:flex-1">
        <div
          ref={setScrollElement}
          className="tw:min-h-0 tw:w-1/2 tw:overflow-auto tw:border-r tw:border-border-subtle tw:p-2"
        >
          <VirtualTreeRows
            rows={fixture.rows.slice(0, visibleCount)}
            scrollElement={scrollElement}
          />
        </div>
        <ol className="tw:m-0 tw:min-h-0 tw:w-1/2 tw:overflow-auto tw:p-3 tw:text-sm">
          {searchLabels.map((label) => <li key={label}>{label}</li>)}
        </ol>
      </div>
    </BenchmarkSurface>
  );
}

function explorerFixture() {
  const items: SearchEverywhereItem[] = [];
  const rows: VirtualTreeRow[] = [];
  for (let index = 0; index < 5_000; index += 1) {
    const connection = index % 20;
    const database = index % 50;
    const label = `object-${index}`;
    items.push({
      id: `object:${index}`,
      kind: "databaseObject",
      label,
      detail: `connection-${connection} / database-${database}`,
      keywords: [`schema-${index % 25}`, `table-${index}`],
      run: () => undefined,
    });
    rows.push({
      key: `row-${index}`,
      render: () => (
        <div className="ds-object-row tw:pl-3 tw:text-ui" role="treeitem">
          {label}
        </div>
      ),
    });
  }
  return { rows, index: indexSearchEverywhereItems(items) };
}

function QueryResultScenario() {
  const largeResult = useMemo(() => queryResult(50_000), []);
  const [result, setResult] = useState<QueryResult>(() => queryResult(0));
  const [backendStatus, setBackendStatus] = useState(0);

  useScenarioRunner(true, async () => {
    await samples("query-first-batch", ACTION_SAMPLES, async () => {
      const receipt = await runPackagedBenchmarkBackend("query-first-batch");
      setResult(receiptResult(receipt));
      return backendEvidence(receipt);
    });

    setResult(largeResult);
    await waitForPackagedPaint();
    await samples("query-grid-scroll-50k", 10, async (index) => {
      const scroller = document.querySelector<HTMLElement>("[data-data-grid-scroll]");
      if (!scroller) throw new Error("grid scroller unavailable");
      if (scroller.scrollWidth <= scroller.clientWidth) {
        throw new Error("dense grid horizontal scroll unavailable");
      }
      const left = (index % 4) * 180;
      scroller.scrollTo({
        top: index % 2 === 0 ? scroller.scrollHeight : 0,
        left,
      });
      await waitForPackagedPaint();
      if (left > 0 && scroller.scrollLeft === 0) {
        throw new Error("dense grid horizontal scroll did not advance");
      }
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await measurePackagedAction("query-page-store-1m", async () => {
      const receipt = await runPackagedBenchmarkBackend("query-page-store-1m");
      setBackendStatus((status) => status + receipt.rowCount);
      return backendEvidence(receipt);
    });
    await runPackagedBenchmarkBackend("query-start-cancellable-export");
    for (const action of ["query-cancel", "query-export"] as const) {
      await measurePackagedAction(action, async () => {
        const receipt = await runPackagedBenchmarkBackend(action);
        setBackendStatus((status) => status + receipt.rowCount);
        return backendEvidence(receipt);
      });
    }
    await finishBenchmark();
  });

  return (
    <BenchmarkSurface title={`Query result · 50,000 rows × ${DENSE_GRID_COLUMN_COUNT} columns · backend ${backendStatus}`}>
      <DataGrid result={result} surface="workbench" />
    </BenchmarkSurface>
  );
}

function TableFirstRowScenario() {
  const [result, setResult] = useState<QueryResult>(() => queryResult(0));

  useScenarioRunner(true, async () => {
    await runTablePage("table-first-page-cold");
    for (let index = 0; index < ACTION_SAMPLES; index += 1) {
      await runTablePage("table-first-page");
    }
    await finishBenchmark();
  });

  async function runTablePage(
    action: "table-first-page-cold" | "table-first-page",
  ) {
    setResult(queryResult(0));
    await waitForPackagedPaint();
    await measurePackagedAction(action, async () => {
      const observation: {
        firstBatchAcceptedAtMs: number | null;
        stages: NonNullable<SqlStreamReceipt["benchmarkStages"]> | null;
      } = {
        firstBatchAcceptedAtMs: null,
        stages: null,
      };
      const pageResult = await runSqlReadPage(
        FIXTURE_CONNECTION_ID,
        "SELECT * FROM benchmark_table LIMIT 101 OFFSET 0",
        "packaged-benchmark",
        undefined,
        {
          onFirstBatchAccepted: (acceptedAtMs) => {
            observation.firstBatchAcceptedAtMs = acceptedAtMs;
          },
          onComplete: (receipt) => {
            observation.stages = receipt.benchmarkStages ?? null;
          },
        },
      );
      if (pageResult.columns.length !== DENSE_GRID_COLUMN_COUNT) {
        throw new Error("Table benchmark fixture column count changed");
      }
      if (pageResult.rows.length !== 101) {
        throw new Error("Table benchmark fixture page size changed");
      }
      const rows = pageResult.rows.slice(0, 100);
      const visibleResult = {
        ...pageResult,
        rows,
        rowCount: rows.length,
        truncated: true,
      };
      const ipcPayloadBytes = new TextEncoder().encode(JSON.stringify({
        columns: pageResult.columns,
        rows: pageResult.rows,
      })).byteLength;
      const { stages } = observation;
      setResult(visibleResult);
      return {
        ipcPayloadBytes,
        retainedBytes: ipcPayloadBytes,
        sqliteTransactionCount: 0,
        backendRequestToFirstRowMs: stages?.firstRowMs ?? null,
        backendFirstRowToIpcBatchMs:
          stages?.firstRowMs != null && stages.firstIpcBatchMs != null
            ? Math.max(0, stages.firstIpcBatchMs - stages.firstRowMs)
            : null,
        operationClaimMs: stages?.operationClaimMs ?? null,
        poolConnectStartMs: stages?.poolConnectStartMs ?? null,
        poolConnectReadyMs: stages?.poolConnectReadyMs ?? null,
        backendExecuteStartMs: stages?.backendExecuteStartMs ?? null,
        firstRowMs: stages?.firstRowMs ?? null,
        firstIpcBatchMs: stages?.firstIpcBatchMs ?? null,
        ipcBatchAcceptedAtMs: observation.firstBatchAcceptedAtMs,
      } satisfies PackagedActionEvidence;
    });
  }

  return (
    <BenchmarkSurface title="Table data · local SQLite · first 100-row page">
      <DataGrid result={result} surface="workbench" />
    </BenchmarkSurface>
  );
}

function queryResult(rowCount: number): QueryResult {
  const columns = Array.from(
    { length: DENSE_GRID_COLUMN_COUNT },
    (_, index) => index === 0 ? "id" : `metric_${index}`,
  );
  return {
    columns,
    rows: Array.from({ length: rowCount }, (_, rowIndex) =>
      columns.map((_, columnIndex) =>
        columnIndex === 0
          ? rowIndex
          : (rowIndex * (columnIndex + 1)) % 10_000,
      ),
    ),
    rowCount,
    truncated: false,
    durationMs: 0,
  };
}

function receiptResult(receipt: PackagedBackendReceipt): QueryResult {
  return {
    columns: receipt.columns,
    rows: receipt.rows,
    rowCount: receipt.rows.length,
    truncated: receipt.rowCount > receipt.rows.length,
    durationMs: receipt.backendRequestToFirstRowMs ?? 0,
  };
}

function backendEvidence(receipt: PackagedBackendReceipt): PackagedActionEvidence {
  return {
    backendRequestToFirstRowMs: receipt.backendRequestToFirstRowMs,
    backendFirstRowToIpcBatchMs: receipt.backendFirstRowToIpcBatchMs,
    ipcPayloadBytes: receipt.ipcPayloadBytes,
    sqliteTransactionCount: receipt.sqliteTransactionCount,
    retainedBytes: receipt.retainedBytes,
  };
}

function AgentTranscriptScenario() {
  const [projection, setProjection] = useState<AcpConversationProjection>(() =>
    createAcpConversationProjection([]),
  );
  const [turnComplete, setTurnComplete] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useScenarioRunner(true, async () => {
    let currentProjection = projection;
    await measurePackagedAction("agent-stream-10k", async () => {
      const events = agentEvents(10_000);
      const persisted = runPackagedBenchmarkBackend("agent-stream-10k");
      const merged = appendAcpConversationEvents(currentProjection, events).projection;
      currentProjection = merged;
      setProjection({ ...merged });
      const receipt = await persisted;
      return {
        ...backendEvidence(receipt),
        retainedBytes:
          merged.transcriptBytes + merged.recentBytes + receipt.retainedBytes,
      };
    });
    await waitForPackagedPaint();
    setTurnComplete(true);
    await waitForPackagedPaint();
    await samples("agent-manual-scroll", ACTION_SAMPLES, (index) => {
      const transcript = transcriptRef.current;
      if (!transcript) throw new Error("Agent transcript unavailable");
      transcript.scrollTop = index % 2 === 0 ? 0 : transcript.scrollHeight;
      transcript.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await measurePackagedAction("agent-permission", () => {
      const event = permissionEvent(currentProjection.lastSequence + 1);
      const merged = appendAcpConversationEvents(currentProjection, [event]).projection;
      currentProjection = merged;
      setProjection({ ...merged });
    });
    await measurePackagedAction("agent-reconnect", () => {
      const replay = agentEvents(
        512,
        Math.max(1, currentProjection.lastSequence - 511),
      );
      const merged = mergeAcpConversationFocus(currentProjection, replay, true);
      currentProjection = merged;
      setProjection({ ...merged });
      return { retainedBytes: merged.transcriptBytes + merged.recentBytes };
    });
    await finishBenchmark();
  });

  const items = visibleAcpTranscriptItems(projection);
  return (
    <BenchmarkSurface title={`Agent · 10 minute / 10,000 event transcript · ${items.length} retained items`}>
      <div ref={transcriptRef} className="tw:min-h-0 tw:flex-1 tw:overflow-auto tw:p-4">
        <div className="tw:grid tw:min-w-0 tw:gap-3">
          {items.map((item) => (
            <BenchmarkTranscriptItem
              key={item.key}
              item={item}
              turnComplete={turnComplete}
            />
          ))}
        </div>
      </div>
    </BenchmarkSurface>
  );
}

function skillExpectations(status: SkillStatus): SkillTargetExpectation[] {
  return status.targets.map((target) => ({
    target: target.target,
    inventoryFingerprint: target.inventoryFingerprint,
  }));
}

function assertSkillState(status: SkillStatus, expected: "missing" | "managed_current") {
  if (
    status.targets.length !== 2
    || status.targets.some((target) => target.state !== expected)
  ) {
    throw new Error(`packaged Skill inventory did not converge to ${expected}`);
  }
  if (
    expected === "managed_current"
    && status.targets.some(
      (target) =>
        target.installedRevision !== status.skill.releaseRevision
        || target.installedPackageDigest !== status.skill.packageDigest,
    )
  ) {
    throw new Error("packaged Skill inventory revision or digest is stale");
  }
}

function AgentToolsScenario({
  phase,
}: {
  phase: "install" | "restart" | null;
}) {
  const { setLang } = useI18n();
  const [status, setStatus] = useState<SkillStatus | null>(null);
  const [surfaceMounted, setSurfaceMounted] = useState(true);
  const [settingsMounted, setSettingsMounted] = useState(false);

  useScenarioRunner(true, async () => {
    await setPackagedBenchmarkCompactWindow(true);
    await waitForPackagedViewport(360, 640);
    for (const lang of ["en", "ko"] as const) {
      setLang(lang);
      await waitForDocumentLanguage(lang);
      if (lang === "ko") openAgentSetup();
      await validateAndDismissAgentSelectionModal(lang);
    }
    await setPackagedBenchmarkCompactWindow(false);
    await waitForPackagedPaint();
    setSettingsMounted(true);
    await waitForPackagedPaint();
    const initial = await skillStatus("all");
    assertSkillState(initial, phase === "restart" ? "managed_current" : "missing");
    setStatus(initial);

    if (phase !== "restart") {
      await preparePackagedBenchmarkWorkload();
      await measurePackagedAction("agent-skill-install-all", async () => {
        const installButton = await waitForAgentSkillInstallButton();
        installButton.click();
        const installed = await waitForAgentSkillState("managed_current");
        assertSkillState(installed, "managed_current");
        setStatus(installed);
      });
    }

    if (phase !== "install") {
      await preparePackagedBenchmarkWorkload();
      await measurePackagedAction("agent-skill-reload", async () => {
        const receipt = await runPackagedBenchmarkBackend("agent-skill-reload");
        if (receipt.rowCount !== 2) {
          throw new Error("restarted app did not find both packaged Skill targets");
        }
        const reloaded = await skillStatus("all");
        assertSkillState(reloaded, "managed_current");
        setStatus({ ...reloaded });
        return backendEvidence(receipt);
      });
      await preparePackagedBenchmarkWorkload();
      await measurePackagedAction("agent-skill-remove-all", async () => {
        const current = await skillStatus("all");
        const receipt = await removeSkill("all", skillExpectations(current));
        assertSkillState(receipt.status, "missing");
        if (receipt.changedTargets.length !== 2) {
          throw new Error("packaged Skill removal did not change both targets");
        }
        setStatus(receipt.status);
      });
    }
    setSurfaceMounted(false);
    await waitForPackagedPaint();
    // Let the final observer-owned request that started before unmount settle;
    // the following window owns only timers/listeners that survived cleanup.
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    await measurePackagedIdle(1_500);
    await finishBenchmark();
  });

  return (
    <BenchmarkSurface title={`Agent tools · ${phase ?? "single-process compatibility"}`}>
      <div className="tw:min-h-0 tw:flex-1 tw:overflow-auto">
        {surfaceMounted ? (
          <>
            <SkillStartupGate />
            {settingsMounted ? <AgentToolsSettings /> : null}
          </>
        ) : null}
        <output className="tw:sr-only" aria-live="polite">
          {status?.targets.map((target) => `${target.target}:${target.state}`).join(",")}
        </output>
      </div>
    </BenchmarkSurface>
  );
}

async function waitForPackagedViewport(maxWidth: number, maxHeight: number) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (window.innerWidth <= maxWidth && window.innerHeight <= maxHeight) return;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("packaged compact viewport timed out");
}

async function waitForDocumentLanguage(lang: Lang) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (document.documentElement.lang === lang) {
      await waitForPackagedPaint();
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("packaged Agent locale timed out");
}

async function validateAndDismissAgentSelectionModal(lang: Lang) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-modal="true"]',
    );
    if (dialog) {
      const titleId = dialog.getAttribute("aria-labelledby");
      const descriptionId = dialog.getAttribute("aria-describedby");
      const checkedTargets = dialog.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]:checked',
      );
      const title = titleId ? document.getElementById(titleId)?.textContent?.trim() : null;
      const description = descriptionId
        ? document.getElementById(descriptionId)?.textContent?.trim()
        : null;
      if (
        !titleId
        || !descriptionId
        || !document.getElementById(titleId)
        || !document.getElementById(descriptionId)
        || document.documentElement.lang !== lang
        || title !== messages[lang]["agentTools.startupTitle"]
        || description !== messages[lang]["agentTools.startupBody"]
        || checkedTargets.length !== 2
      ) {
        throw new Error("Agent selection modal accessibility contract is incomplete");
      }
      const bounds = dialog.getBoundingClientRect();
      if (
        window.innerWidth > 360
        || window.innerHeight > 640
        || bounds.left < 0
        || bounds.top < 0
        || bounds.right > window.innerWidth
        || bounds.bottom > window.innerHeight
        || dialog.scrollWidth > dialog.clientWidth
      ) {
        throw new Error("Agent selection modal escaped the 360px packaged viewport");
      }
      const initialFocus = dialog.querySelector<HTMLElement>(
        "[data-modal-initial-focus]",
      );
      if (document.activeElement !== initialFocus) {
        await waitForPackagedPaint();
      }
      if (document.activeElement !== initialFocus) {
        throw new Error("Agent selection modal did not establish keyboard focus");
      }
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
      const last = focusable[focusable.length - 1];
      last?.focus();
      last?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }));
      if (document.activeElement !== focusable[0]) {
        throw new Error("Agent selection modal did not contain forward keyboard focus");
      }
      focusable[0]?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
      if (document.activeElement !== last) {
        throw new Error("Agent selection modal did not contain reverse keyboard focus");
      }
      dialog.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
      await waitForPackagedPaint();
      if (document.body.contains(dialog)) {
        throw new Error("Agent selection modal did not close from the keyboard");
      }
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("Agent selection modal surface timed out");
}

async function waitForAgentSkillInstallButton() {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-agent-skill-batch-action="install"]',
    );
    if (button && !button.disabled) return button;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("Agent Tools install surface timed out");
}

async function waitForAgentSkillState(expected: "managed_current" | "missing") {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const status = await skillStatus("all");
    if (status.targets.every((target) => target.state === expected)) return status;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error(`Agent Tools inventory timed out waiting for ${expected}`);
}

function BenchmarkTranscriptItem({
  item,
  turnComplete,
}: {
  item: AcpTranscriptItem;
  turnComplete: boolean;
}) {
  if (item.kind === "agent" || item.kind === "thought") {
    if (item.kind === "agent" && turnComplete) {
      return (
        <AgentRichText
          labels={agentRichTextLabels}
          text={item.chunks.join("")}
        />
      );
    }
    return <AgentStreamingText chunks={item.chunks} revision={item.revision} />;
  }
  if (item.kind === "permission") {
    return (
      <AgentPermissionCard
        title="Permission"
        description="Synthetic benchmark permission"
        pending
        status="Waiting"
        actions={<button type="button">Allow once</button>}
      />
    );
  }
  if (item.kind === "user") {
    return <p className="tw:m-0 tw:rounded-md tw:bg-selection tw:p-2">{item.text}</p>;
  }
  if (item.kind === "turnEnd") {
    return (
      <AgentRichText
        labels={agentRichTextLabels}
        text={`Completed: ${item.stopReason}`}
      />
    );
  }
  return <span className="tw:text-xs tw:text-muted-foreground">activity</span>;
}

const agentRichTextLabels = {
  copied: "Copied",
  copyCode: "Copy",
  diagram: "Diagram",
  diagramError: "Diagram error",
  diagramLoading: "Loading",
  diagramSource: "Source",
  imageOmitted: "Image omitted",
  openLink: "Open",
  plainTextFallback: "Shown as plain text for stability",
};

function agentEvents(count: number, start = 1): AcpSessionEvent[] {
  const sessionId = "00000000-0000-0000-0000-0000000000ac" as AcpSessionId;
  return Array.from({ length: count }, (_, offset) => {
    const sequence = start + offset;
    return {
      sessionId,
      sequence,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence * 0.06)).toISOString(),
      type: "sessionUpdate" as const,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "benchmark-message",
        content: { type: "text", text: `${sequence % 10}` },
      },
    };
  });
}

function permissionEvent(sequence: number): AcpSessionEvent {
  return {
    sessionId: "00000000-0000-0000-0000-0000000000ac" as AcpSessionId,
    sequence,
    createdAt: "2026-01-01T00:10:00.000Z",
    type: "permissionRequest",
    requestId: "benchmark-permission",
    toolCall: { title: "Read schema" },
    options: [{ id: "once", name: "Allow once", kind: "allowOnce" }],
  };
}

function LongLivedDataScenario() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useScenarioRunner(true, async () => {
    for (const action of [
      "history-10k",
      "audit-100k",
      "local-history-50",
      "analysis-article-multi-block",
    ] as const satisfies readonly PackagedBackendAction[]) {
      await samples(action, ACTION_SAMPLES, async () => {
        const receipt = await runPackagedBenchmarkBackend(action);
        setCounts((current) => ({ ...current, [action]: receipt.rowCount }));
        return backendEvidence(receipt);
      });
    }
    await finishBenchmark();
  });
  return (
    <BenchmarkSurface title="Long-lived data · bounded production pages">
      <pre className="tw:m-0 tw:min-h-0 tw:flex-1 tw:overflow-auto tw:p-4 tw:text-xs">
        {JSON.stringify(counts, null, 2)}
      </pre>
    </BenchmarkSurface>
  );
}

function InteractionSurfacesScenario() {
  const snapshot = useMemo(erdSnapshot, []);
  const result = useMemo(() => queryResult(50_000), []);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [surface, setSurface] = useState<"erd" | "workbench">("erd");
  const layout = useToolWindowLayout();

  useScenarioRunner(true, async () => {
    await waitForSelector("[data-erd-neighborhood-toggle]");
    const toggle = document.querySelector<HTMLButtonElement>("[data-erd-neighborhood-toggle]");
    if (toggle?.getAttribute("aria-pressed") === "true") toggle.click();
    await waitForPackagedPaint();
    await waitForSelector(".react-flow__node");
    await samples("erd-drag-1k", ACTION_SAMPLES, (index) => {
      const node = document.querySelector<HTMLElement>(".react-flow__node");
      if (!node) throw new Error("ERD node unavailable");
      pointerDrag(node, 100 + index * 3, 120 + index * 3, 180 + index * 3, 190 + index * 3);
    });

    setSurface("workbench");
    await waitForPackagedPaint();
    await waitForSelector("[data-grid-resize-handle]");
    await samples("grid-and-pane-resize", 10, (index) => {
      const handle = document.querySelector<HTMLElement>("[data-grid-resize-handle]");
      if (!handle) throw new Error("grid resize handle unavailable");
      mouseDrag(handle, 200, 200 + (index % 5) * 24, 300, 300);
      layout.startServicesResize({ preventDefault: () => undefined, clientY: 500 });
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 420 - index }));
      document.dispatchEvent(new MouseEvent("mouseup", { clientY: 400 - index }));
    });
    await samples("workbench-scroll-continuity", ACTION_SAMPLES, async (index) => {
      const documentScroller = document.querySelector<HTMLElement>(
        '[data-workbench-scroll-owner="document"]',
      );
      const gridScroller = document.querySelector<HTMLElement>("[data-data-grid-scroll]");
      const lastAction = document.querySelector<HTMLButtonElement>(
        "[data-benchmark-last-action]",
      );
      if (!documentScroller || !gridScroller || !lastAction) {
        throw new Error("workbench scroll surface unavailable");
      }

      documentScroller.scrollTop = documentScroller.scrollHeight;
      documentScroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      gridScroller.scrollTop = gridScroller.scrollHeight;
      gridScroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      lastAction.focus();

      layout.startServicesResize({ preventDefault: () => undefined, clientY: 500 });
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 360 + index * 8 }));
      document.dispatchEvent(new MouseEvent("mouseup", { clientY: 360 + index * 8 }));
      await waitForPackagedPaint();

      const documentBottom = documentScroller.scrollHeight
        - documentScroller.clientHeight
        - documentScroller.scrollTop;
      if (documentBottom > 2 || gridScroller.scrollTop <= 0) {
        throw new Error("workbench scroll position was not preserved");
      }
      if (document.activeElement !== lastAction) {
        throw new Error("workbench focus was not preserved");
      }
    });
    await finishBenchmark();
  });

  return (
    <BenchmarkSurface title="Interactions · 1,000-node ERD · grid and Services resize">
      <div className="tw:flex tw:min-h-0 tw:flex-1">
        {surface === "erd" ? (
          <div className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col">
            <ErdCanvas
              snapshot={snapshot}
              filter=""
              selectedKey={selectedKey}
              onSelect={(relation) => setSelectedKey(JSON.stringify(relation.object))}
              onOpen={() => undefined}
            />
          </div>
        ) : (
          <>
            <div className="tw:flex tw:min-h-0 tw:w-1/2 tw:flex-col tw:border-r tw:border-border-subtle">
              <DataGrid result={result} surface="workbench" />
              <div
                className="tw:relative tw:shrink-0 tw:border-t tw:border-border-subtle tw:bg-card"
                style={{ height: layout.servicesHeight }}
              >
                <div className="tw:absolute tw:-top-1 tw:h-2 tw:w-full tw:cursor-row-resize" />
                <span className="tw:p-3 tw:text-sm">Services</span>
              </div>
            </div>
            <WorkbenchScrollBody aria-label="Scrollable workbench document">
              <div className="tw:flex tw:shrink-0 tw:flex-col tw:gap-2 tw:p-3">
                {Array.from({ length: 80 }, (_, index) => (
                  <p className="tw:m-0 tw:text-sm" key={index}>
                    Workbench document row {index + 1}
                  </p>
                ))}
                <WorkbenchButton data-benchmark-last-action>
                  Last document action
                </WorkbenchButton>
              </div>
            </WorkbenchScrollBody>
          </>
        )}
      </div>
    </BenchmarkSurface>
  );
}

function erdSnapshot(): CatalogSnapshot {
  return {
    schemaVersion: 2,
    connectionId: FIXTURE_CONNECTION_ID,
    engine: "sqlite",
    database: "benchmark",
    capturedAt: "2026-01-01T00:00:00.000Z",
    fingerprint: "e".repeat(64),
    namespaces: [{ name: "main", comment: null }],
    relations: Array.from({ length: 1_000 }, (_, index) => ({
      object: {
        catalog: "benchmark",
        namespace: "main",
        name: `relation_${index}`,
        kind: "table" as const,
        nativeId: String(index),
      },
      comment: null,
      rowEstimate: 1_000,
      partitionParent: null,
      partitionChildren: [],
      columns: [
        {
          name: "id",
          ordinal: 1,
          nativeType: "INTEGER",
          typeFamily: "integer" as const,
          length: null,
          precision: null,
          scale: null,
          nullable: false,
          defaultExpression: null,
          generatedExpression: null,
          identity: true,
          autoIncrement: true,
          collation: null,
          comment: null,
          sensitivity: null,
        },
      ],
      constraints: [],
      indexes: [],
    })),
    routines: [],
    otherObjects: [],
  };
}

function pointerDrag(
  target: HTMLElement,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) {
  const options = { bubbles: true, pointerId: 1, pointerType: "mouse", buttons: 1 };
  target.dispatchEvent(new PointerEvent("pointerdown", { ...options, clientX: startX, clientY: startY }));
  document.dispatchEvent(new PointerEvent("pointermove", { ...options, clientX: endX, clientY: endY }));
  document.dispatchEvent(new PointerEvent("pointerup", { ...options, buttons: 0, clientX: endX, clientY: endY }));
}

function mouseDrag(
  target: HTMLElement,
  startX: number,
  endX: number,
  startY: number,
  endY: number,
) {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: startX, clientY: startY }));
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: endX, clientY: endY }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: endX, clientY: endY }));
}

async function waitForSelector(selector: string) {
  for (let frame = 0; frame < 120; frame += 1) {
    if (document.querySelector(selector)) return;
    await waitForPackagedPaint();
  }
  throw new Error("benchmark surface did not become ready");
}

function IdleRuntimeScenario() {
  useScenarioRunner(true, async () => {
    await measurePackagedIdle(10_000);
    await finishBenchmark();
  });
  return <BenchmarkSurface title="Idle runtime · 10 second IPC observation" />;
}
