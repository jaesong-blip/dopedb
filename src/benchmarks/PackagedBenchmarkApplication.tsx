import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";

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
import type { CatalogSnapshot, QueryResult } from "../ipc/types";
import {
  completePackagedBenchmark,
  failPackagedBenchmark,
  type PackagedBenchmarkFailureReason,
} from "../features/runtime/tauriAdapter";
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
const FIXTURE_CONNECTION_ID = "bed00000-0000-0000-0000-000000000001";

export function PackagedBenchmarkApplication({
  scenario,
}: {
  scenario: string;
}) {
  switch (scenario) {
    case "sql-editor":
      return <SqlEditorScenario />;
    case "explorer-search":
      return <ExplorerSearchScenario />;
    case "query-result":
      return <QueryResultScenario />;
    case "agent-transcript":
      return <AgentTranscriptScenario />;
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
    void latest.current().catch((error) =>
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
      replaceDocument(view, source);
      await waitForPackagedPaint();

      await samples(`sql-editor-${label}-type`, ACTION_SAMPLES, (index) => {
        const position = Math.max(0, view.state.doc.length - index);
        view.dispatch({ changes: { from: position, insert: " " } });
      });
      await samples(`sql-editor-${label}-cursor`, ACTION_SAMPLES, (index) => {
        const position = Math.floor(
          (view.state.doc.length * (index + 1)) / (ACTION_SAMPLES + 1),
        );
        view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
      });
      await samples(`sql-editor-${label}-format`, 2, async () => {
        replaceDocument(view, source);
        await waitForPackagedPaint();
        const formatted = await formatSqlDocument(
          view.state.doc.toString(),
          "sqlite",
        );
        replaceDocument(view, formatted);
      });
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
    }
    await finishBenchmark();
  });

  return (
    <BenchmarkSurface title={`SQL editor · ${value.length} bytes · runs ${runCount}`}>
      <SqlViewer
        value={value}
        editable
        engine="sqlite"
        minHeight="100%"
        onChange={setValue}
        onEditorReady={setView}
        onRun={() => setRunCount((count) => count + 1)}
      />
    </BenchmarkSurface>
  );
}

function replaceDocument(view: EditorView, value: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
    selection: { anchor: 0 },
  });
}

function ExplorerSearchScenario() {
  const fixture = useMemo(explorerFixture, []);
  const [visibleCount, setVisibleCount] = useState(0);
  const [searchLabels, setSearchLabels] = useState<string[]>([]);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);

  useScenarioRunner(scrollElement !== null, async () => {
    for (let index = 0; index < ACTION_SAMPLES; index += 1) {
      setVisibleCount(0);
      await waitForPackagedPaint();
      await measurePackagedAction("explorer-first-expand", () => {
        setVisibleCount(2_500);
      });
    }
    for (let index = 0; index < ACTION_SAMPLES; index += 1) {
      setVisibleCount(2_500);
      await waitForPackagedPaint();
      await measurePackagedAction("explorer-secondary-expand", () => {
        setVisibleCount(5_000);
      });
    }
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

    await samples("query-grid-scroll-50k", 10, (index) => {
      if (index === 0) {
        setResult(largeResult);
      }
      const scroller = document.querySelector<HTMLElement>("[data-data-grid-scroll]");
      if (!scroller) throw new Error("grid scroller unavailable");
      scroller.scrollTo({
        top: index % 2 === 0 ? scroller.scrollHeight : 0,
        left: (index % 4) * 180,
      });
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
    <BenchmarkSurface title={`Query result · 50,000 visible rows · backend ${backendStatus}`}>
      <DataGrid result={result} surface="workbench" />
    </BenchmarkSurface>
  );
}

function queryResult(rowCount: number): QueryResult {
  const columns = ["id", "account", "region", "state", "score", "created", "flag", "note"];
  return {
    columns,
    rows: Array.from({ length: rowCount }, (_, index) => [
      index,
      index % 1_000,
      index % 12,
      index % 4,
      index / 10,
      index % 365,
      index % 2,
      index % 100,
    ]),
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
          {items.map((item) => <BenchmarkTranscriptItem key={item.key} item={item} />)}
        </div>
      </div>
    </BenchmarkSurface>
  );
}

function BenchmarkTranscriptItem({ item }: { item: AcpTranscriptItem }) {
  if (item.kind === "agent" || item.kind === "thought") {
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
      "dashboard-multi-tile",
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

    await samples("grid-and-pane-resize", 10, (index) => {
      const handle = document.querySelector<HTMLElement>("[data-grid-resize-handle]");
      if (!handle) throw new Error("grid resize handle unavailable");
      mouseDrag(handle, 200, 200 + (index % 5) * 24, 300, 300);
      layout.startServicesResize({ preventDefault: () => undefined, clientY: 500 });
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 420 - index }));
      document.dispatchEvent(new MouseEvent("mouseup", { clientY: 400 - index }));
    });
    await finishBenchmark();
  });

  return (
    <BenchmarkSurface title="Interactions · 1,000-node ERD · grid and Services resize">
      <div className="tw:flex tw:min-h-0 tw:flex-1">
        <div className="tw:flex tw:min-h-0 tw:w-1/2 tw:flex-col tw:border-r tw:border-border-subtle">
          <ErdCanvas
            snapshot={snapshot}
            filter=""
            selectedKey={selectedKey}
            onSelect={(relation) => setSelectedKey(JSON.stringify(relation.object))}
            onOpen={() => undefined}
          />
        </div>
        <div className="tw:flex tw:min-h-0 tw:w-1/2 tw:flex-col">
          <DataGrid result={result} surface="workbench" />
          <div
            className="tw:relative tw:shrink-0 tw:border-t tw:border-border-subtle tw:bg-card"
            style={{ height: layout.servicesHeight }}
          >
            <div className="tw:absolute tw:-top-1 tw:h-2 tw:w-full tw:cursor-row-resize" />
            <span className="tw:p-3 tw:text-sm">Services</span>
          </div>
        </div>
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
