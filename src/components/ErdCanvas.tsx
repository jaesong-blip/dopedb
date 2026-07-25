// React Flow ERD surface with cancellable ELK layout, workspace-scoped persistence,
// virtual relationship overlays, deterministic local export, and large-schema modes.
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type NodeChange,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { saveErdLayout } from "../ipc/commands";
import type {
  CatalogRelationV2,
  CatalogSnapshot,
  ErdCanvasLayout,
  ErdLayout,
  ErdLayoutMode,
  ErdVirtualRelation,
} from "../ipc/types";
import { errMessage } from "../ipc/types";
import ErdRelationNode, {
  type ErdFlowNode,
} from "./ErdRelationNode";
import ErdToolbar from "./ErdToolbar";
import {
  buildErdGraph,
  createErdGraphIndex,
  erdRelationKey,
  relationDisplayName,
} from "../lib/erdGraph";
import {
  createErdShareDocument,
  downloadErdPdf,
  downloadErdPng,
  downloadErdShare,
  downloadErdSvg,
} from "../lib/erdExport";
import {
  fallbackErdPositions,
  requestErdLayout,
  type ErdPositions,
} from "../lib/erdLayout";
import { erdLayoutsQuery, qk } from "../lib/queries";
import { useI18n } from "../lib/i18n";
import "./ErdCanvas.css";

const AUTO_COMPACT_THRESHOLD = 100;
const MINIMAP_THRESHOLD = 500;
const MAX_AUTO_LAYOUT_NODES = 2_000;
const MAX_RENDERED_NODES = 3_000;
const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const nodeTypes = { relation: ErdRelationNode };

function mergePositions(
  relations: CatalogRelationV2[],
  current: ErdPositions,
): ErdPositions {
  const fallback = fallbackErdPositions(
    relations.map((relation) => ({
      id: erdRelationKey(relation.object),
      relation,
    })),
  );
  return { ...fallback, ...current };
}

function toCanvasLayout(
  relations: CatalogRelationV2[],
  positions: ErdPositions,
  viewport: Viewport,
  compact: boolean,
): ErdCanvasLayout {
  const complete = mergePositions(relations, positions);
  return {
    nodes: Object.entries(complete).map(([relationKey, position]) => ({
      relationKey,
      ...position,
    })),
    viewport,
    compact,
    hiddenRelationKeys: [],
  };
}

export default function ErdCanvas({
  snapshot,
  filter,
  selectedKey,
  onSelect,
  onOpen,
}: {
  snapshot: CatalogSnapshot;
  filter: string;
  selectedKey: string | null;
  onSelect: (relation: CatalogRelationV2) => void;
  onOpen: (relation: CatalogRelationV2) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const layoutsQuery = useQuery(erdLayoutsQuery(snapshot.connectionId));
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [name, setName] = useState(t("schema.erdDefaultName"));
  const [mode, setMode] = useState<ErdLayoutMode>("physical");
  const [compact, setCompact] = useState(
    snapshot.relations.length > AUTO_COMPACT_THRESHOLD,
  );
  const [neighborhood, setNeighborhood] = useState(false);
  const [virtualRelations, setVirtualRelations] = useState<
    ErdVirtualRelation[]
  >([]);
  const [positions, setPositions] = useState<ErdPositions>(() =>
    fallbackErdPositions(
      snapshot.relations.slice(0, MAX_RENDERED_NODES).map((relation) => ({
        id: erdRelationKey(relation.object),
        relation,
      })),
    ),
  );
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [virtualEditorOpen, setVirtualEditorOpen] = useState(false);
  const [virtualFrom, setVirtualFrom] = useState("");
  const [virtualTo, setVirtualTo] = useState("");
  const [virtualFromColumns, setVirtualFromColumns] = useState("");
  const [virtualToColumns, setVirtualToColumns] = useState("");
  const [virtualLabel, setVirtualLabel] = useState("");
  const flowRef = useRef<ReactFlowInstance<ErdFlowNode, Edge> | null>(null);
  const layoutAbort = useRef<AbortController | null>(null);
  const initializedFor = useRef("");
  const deferredFilter = useDeferredValue(filter);
  const graphIndex = useMemo(() => createErdGraphIndex(snapshot), [snapshot]);

  const graph = useMemo(
    () =>
      buildErdGraph(snapshot, virtualRelations, {
        filter: deferredFilter,
        neighborhoodOf: neighborhood ? selectedKey : null,
        limit: MAX_RENDERED_NODES,
        index: graphIndex,
      }),
    [
      deferredFilter,
      graphIndex,
      neighborhood,
      selectedKey,
      snapshot,
      virtualRelations,
    ],
  );
  const graphRelations = useMemo(
    () => graph.nodes.map((node) => node.relation),
    [graph.nodes],
  );
  const relationByKey = useMemo(
    () =>
      new Map(
        snapshot.relations.map((relation) => [
          erdRelationKey(relation.object),
          relation,
        ]),
      ),
    [snapshot.relations],
  );

  const flowNodes = useMemo<ErdFlowNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: "relation",
        position: positions[node.id] ?? { x: 0, y: 0 },
        selected: node.id === selectedKey,
        data: { relation: node.relation, compact },
      })),
    [compact, graph.nodes, positions, selectedKey],
  );
  const flowEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "smoothstep",
        label:
          graph.edges.length <= 300
            ? `${edge.sourceColumns.join(", ")} → ${edge.targetColumns.join(", ")}`
            : undefined,
        markerEnd: { type: MarkerType.ArrowClosed },
        className: edge.virtual ? "erd-edge-virtual" : "erd-edge-physical",
        style: edge.virtual
          ? {
              stroke: "var(--ds-accent-text)",
              strokeDasharray: "7 5",
              strokeWidth: 2,
            }
          : { stroke: "var(--ds-text-muted)" },
      })),
    [graph.edges],
  );

  const autoLayout = useCallback(async () => {
    if (graph.nodes.length > MAX_AUTO_LAYOUT_NODES) {
      setError(
        t("schema.erdLayoutLimit", {
          limit: MAX_AUTO_LAYOUT_NODES,
        }),
      );
      return;
    }
    layoutAbort.current?.abort();
    const controller = new AbortController();
    layoutAbort.current = controller;
    setBusy(true);
    setError(null);
    try {
      const next = await requestErdLayout(
        graph.nodes,
        graph.edges,
        compact,
        controller.signal,
      );
      setPositions((current) => ({ ...current, ...next }));
      setDirty(true);
      window.requestAnimationFrame(() => {
        void flowRef.current?.fitView({ padding: 0.12, duration: 240 });
      });
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(errMessage(cause));
      }
    } finally {
      if (layoutAbort.current === controller) {
        layoutAbort.current = null;
        setBusy(false);
      }
    }
  }, [compact, graph.edges, graph.nodes, t]);

  const applyLayout = useCallback(
    (layout: ErdLayout) => {
      const savedPositions = Object.fromEntries(
        layout.layout.nodes.map((node) => [
          node.relationKey,
          { x: node.x, y: node.y },
        ]),
      );
      setPositions(mergePositions(graphRelations, savedPositions));
      setViewport(layout.layout.viewport);
      setCompact(layout.layout.compact);
      setVirtualRelations(layout.virtualRelations);
      setActiveLayoutId(layout.id);
      setRevision(layout.revision);
      setName(layout.name);
      setMode(layout.mode);
      setDirty(false);
      setError(
        layout.catalogFingerprint === snapshot.fingerprint
          ? null
          : t("schema.erdSchemaChanged"),
      );
      window.requestAnimationFrame(() => {
        void flowRef.current?.setViewport(layout.layout.viewport, {
          duration: 180,
        });
      });
    },
    [graphRelations, snapshot.fingerprint, t],
  );

  useEffect(() => {
    if (layoutsQuery.isPending) return;
    const identity = `${snapshot.connectionId}:${snapshot.fingerprint}`;
    if (initializedFor.current === identity) return;
    initializedFor.current = identity;
    const latest = layoutsQuery.data?.[0];
    if (latest) {
      applyLayout(latest);
      return;
    }
    setActiveLayoutId(null);
    setRevision(null);
    setPositions(mergePositions(graphRelations, {}));
    setCompact(snapshot.relations.length > AUTO_COMPACT_THRESHOLD);
    setVirtualRelations([]);
    setDirty(false);
    void autoLayout();
  }, [
    applyLayout,
    autoLayout,
    layoutsQuery.data,
    layoutsQuery.isPending,
    snapshot.connectionId,
    snapshot.fingerprint,
    graphRelations,
  ]);

  useEffect(() => {
    setPositions((current) => mergePositions(graphRelations, current));
  }, [graphRelations]);

  useEffect(
    () => () => {
      layoutAbort.current?.abort();
    },
    [],
  );

  function selectLayout(id: string | null) {
    if (!id) {
      setActiveLayoutId(null);
      setRevision(null);
      setName(t("schema.erdDefaultName"));
      setMode("physical");
      setVirtualRelations([]);
      setPositions(mergePositions(graphRelations, {}));
      setDirty(true);
      return;
    }
    const layout = layoutsQuery.data?.find((candidate) => candidate.id === id);
    if (layout) applyLayout(layout);
  }

  function handleNodeChanges(changes: NodeChange<ErdFlowNode>[]) {
    const moved = changes.filter(
      (
        change,
      ): change is Extract<NodeChange<ErdFlowNode>, { type: "position" }> =>
        change.type === "position" && Boolean(change.position),
    );
    if (moved.length === 0) return;
    setPositions((current) => {
      const next = { ...current };
      for (const change of moved) {
        if (change.position) next[change.id] = change.position;
      }
      return next;
    });
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const outcome = await saveErdLayout({
        id: activeLayoutId,
        connectionId: snapshot.connectionId,
        name,
        mode,
        catalogFingerprint: snapshot.fingerprint,
        layout: toCanvasLayout(graphRelations, positions, viewport, compact),
        virtualRelations,
        expectedRevision: revision,
      });
      if (!outcome.saved) {
        setError(t("schema.erdSaveConflict"));
        await queryClient.invalidateQueries({
          queryKey: qk.erdLayouts(snapshot.connectionId),
        });
        return;
      }
      setActiveLayoutId(outcome.layout.id);
      setRevision(outcome.layout.revision);
      setDirty(false);
      queryClient.setQueryData<ErdLayout[]>(
        qk.erdLayouts(snapshot.connectionId),
        (current = []) => [
          outcome.layout,
          ...current.filter((layout) => layout.id !== outcome.layout.id),
        ],
      );
    } catch (cause) {
      setError(errMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function addVirtualRelation() {
    const from = relationByKey.get(virtualFrom);
    const to = relationByKey.get(virtualTo);
    const fromColumns = virtualFromColumns
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const toColumns = virtualToColumns
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      !from ||
      !to ||
      from === to ||
      fromColumns.length === 0 ||
      fromColumns.length !== toColumns.length
    ) {
      setError(t("schema.erdInvalidVirtual"));
      return;
    }
    setVirtualRelations((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        fromRelation: from.object,
        fromColumns,
        toRelation: to.object,
        toColumns,
        label: virtualLabel.trim() || null,
      },
    ]);
    setVirtualFromColumns("");
    setVirtualToColumns("");
    setVirtualLabel("");
    setVirtualEditorOpen(false);
    setDirty(true);
    setError(null);
  }

  function currentShareDocument() {
    return createErdShareDocument(
      snapshot,
      mode,
      toCanvasLayout(graphRelations, positions, viewport, compact),
      virtualRelations,
    );
  }

  async function exportGraph(
    format: "svg" | "png" | "pdf" | "json" | "copy",
  ) {
    setError(null);
    try {
      if (format === "svg") {
        downloadErdSvg(name, graph, positions, compact);
      } else if (format === "png") {
        await downloadErdPng(name, graph, positions, compact);
      } else if (format === "pdf") {
        await downloadErdPdf(name, graph, positions, compact);
      } else if (format === "json") {
        downloadErdShare(name, currentShareDocument());
      } else {
        await navigator.clipboard.writeText(
          JSON.stringify(currentShareDocument(), null, 2),
        );
      }
    } catch (cause) {
      setError(errMessage(cause));
    }
  }

  return (
    <div className="erd-surface">
      <ErdToolbar
        layouts={layoutsQuery.data ?? []}
        activeLayoutId={activeLayoutId}
        name={name}
        mode={mode}
        compact={compact}
        neighborhood={neighborhood}
        dirty={dirty}
        busy={busy}
        onSelectLayout={selectLayout}
        onName={(next) => {
          setName(next);
          setDirty(true);
        }}
        onMode={(next) => {
          setMode(next);
          setDirty(true);
        }}
        onAutoLayout={() => void autoLayout()}
        onSave={() => void save()}
        onToggleCompact={() => {
          setCompact((current) => !current);
          setDirty(true);
        }}
        onToggleNeighborhood={() => setNeighborhood((current) => !current)}
        onAddRelation={() => setVirtualEditorOpen((current) => !current)}
        onExport={(format) => void exportGraph(format)}
      />

      {virtualEditorOpen && (
        <div className="erd-virtual-editor ds-control-row">
          <select
            value={virtualFrom}
            onChange={(event) => setVirtualFrom(event.target.value)}
            aria-label={t("schema.erdFromTable")}
          >
            <option value="">{t("schema.erdFromTable")}</option>
            {graphRelations.map((relation) => (
              <option
                key={erdRelationKey(relation.object)}
                value={erdRelationKey(relation.object)}
              >
                {relationDisplayName(relation.object)}
              </option>
            ))}
          </select>
          <input
            value={virtualFromColumns}
            onChange={(event) => setVirtualFromColumns(event.target.value)}
            placeholder={t("schema.erdFromColumns")}
          />
          <select
            value={virtualTo}
            onChange={(event) => setVirtualTo(event.target.value)}
            aria-label={t("schema.erdToTable")}
          >
            <option value="">{t("schema.erdToTable")}</option>
            {graphRelations.map((relation) => (
              <option
                key={erdRelationKey(relation.object)}
                value={erdRelationKey(relation.object)}
              >
                {relationDisplayName(relation.object)}
              </option>
            ))}
          </select>
          <input
            value={virtualToColumns}
            onChange={(event) => setVirtualToColumns(event.target.value)}
            placeholder={t("schema.erdToColumns")}
          />
          <input
            value={virtualLabel}
            onChange={(event) => setVirtualLabel(event.target.value)}
            placeholder={t("schema.erdRelationLabel")}
          />
          <button
            className="btn primary small"
            type="button"
            onClick={addVirtualRelation}
          >
            {t("common.add")}
          </button>
        </div>
      )}

      {virtualRelations.length > 0 && (
        <div className="erd-virtual-list" aria-label={t("schema.erdVirtualRelations")}>
          {virtualRelations.map((relation) => (
            <span className="badge" key={relation.id}>
              {relationDisplayName(relation.fromRelation)}
              {" → "}
              {relationDisplayName(relation.toRelation)}
              <button
                type="button"
                onClick={() => {
                  setVirtualRelations((current) =>
                    current.filter((candidate) => candidate.id !== relation.id),
                  );
                  setDirty(true);
                }}
                aria-label={t("common.remove")}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <div className="error erd-error">{error}</div>}
      {layoutsQuery.error && (
        <div className="error erd-error">
          {errMessage(layoutsQuery.error)}
        </div>
      )}
      <div className="erd-flow">
        <ReactFlow<ErdFlowNode, Edge>
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onInit={(instance) => {
            flowRef.current = instance;
          }}
          onNodesChange={handleNodeChanges}
          onNodeClick={(_, node) => onSelect(node.data.relation)}
          onNodeDoubleClick={(_, node) => onOpen(node.data.relation)}
          onMoveEnd={(_, next) => {
            setViewport(next);
            setDirty(true);
          }}
          minZoom={0.08}
          maxZoom={2.5}
          onlyRenderVisibleElements
          fitView
          fitViewOptions={{ padding: 0.12 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Lines}
            gap={24}
            size={1}
          />
          <Controls showInteractive={false} />
          {flowNodes.length <= MINIMAP_THRESHOLD && (
            <MiniMap pannable zoomable />
          )}
        </ReactFlow>
      </div>
      <footer className="erd-status muted">
        {t("schema.erdVisibleStats", {
          nodes: graph.nodes.length,
          edges: graph.edges.length,
        })}
        {graph.truncated &&
          ` · ${t("schema.erdRenderLimit", {
            shown: graph.nodes.length,
            matched: graph.matchedNodeCount,
          })}`}
        {snapshot.relations.length > AUTO_COMPACT_THRESHOLD &&
          ` · ${t("schema.erdLargeSchema")}`}
      </footer>
    </div>
  );
}
