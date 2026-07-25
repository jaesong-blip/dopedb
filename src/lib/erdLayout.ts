// Cancellable renderer-side adapter for ELK's dedicated worker. A deterministic grid
// remains available when WebKit cannot construct or run the worker so the ERD never
// degrades into a raw runtime error.
import ELK from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import type { ErdGraphEdge, ErdGraphNode } from "./erdGraph";

export type ErdPositions = Record<string, { x: number; y: number }>;

export interface ErdLayoutResult {
  positions: ErdPositions;
  fallback: boolean;
}

type ErdWorkerFactory = () => Worker;

export function fallbackErdPositions(nodes: ErdGraphNode[]): ErdPositions {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  return Object.fromEntries(
    nodes.map((node, index) => [
      node.id,
      {
        x: (index % columns) * 320,
        y: Math.floor(index / columns) * 260,
      },
    ]),
  );
}

function abortError(): DOMException {
  return new DOMException("ERD layout cancelled", "AbortError");
}

function createErdWorker(): Worker {
  return new ElkWorker();
}

export async function requestErdLayout(
  nodes: ErdGraphNode[],
  edges: ErdGraphEdge[],
  compact: boolean,
  signal?: AbortSignal,
  workerFactory: ErdWorkerFactory = createErdWorker,
): Promise<ErdLayoutResult> {
  if (nodes.length === 0) return { positions: {}, fallback: false };
  if (signal?.aborted) throw abortError();

  let worker: Worker | null = null;
  let elk: InstanceType<typeof ELK> | null = null;
  try {
    worker = workerFactory();
    elk = new ELK({ workerFactory: () => worker as Worker });
    const graphPromise = elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.spacing.nodeNodeBetweenLayers": "96",
        "elk.spacing.nodeNode": "56",
        "elk.spacing.edgeNode": "24",
      },
      children: nodes.map((node) => ({
        id: node.id,
        width: 272,
        height: compact
          ? 58
          : Math.min(340, 76 + node.relation.columns.length * 24),
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
    });

    const graph = await new Promise<Awaited<typeof graphPromise>>(
      (resolve, reject) => {
        const abort = () => reject(abortError());
        const fail = () => reject(new Error("ERD layout worker failed"));
        signal?.addEventListener("abort", abort, { once: true });
        worker?.addEventListener("error", fail, { once: true });
        void graphPromise.then(resolve, reject).finally(() => {
          signal?.removeEventListener("abort", abort);
          worker?.removeEventListener("error", fail);
        });
      },
    );
    return {
      positions: Object.fromEntries(
        (graph.children ?? []).map((node) => [
          node.id,
          { x: node.x ?? 0, y: node.y ?? 0 },
        ]),
      ),
      fallback: false,
    };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw cause;
    }
    console.warn("ELK worker unavailable; using deterministic ERD layout", cause);
    return {
      positions: fallbackErdPositions(nodes),
      fallback: true,
    };
  } finally {
    elk?.terminateWorker();
    worker?.terminate();
  }
}
