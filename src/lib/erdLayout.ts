// Cancellable renderer-side adapter for the ELK worker. A deterministic grid is used
// immediately and as a fallback; ELK positions replace it only if the request is still
// current, preventing stale large-schema layouts from jumping the canvas later.
import type { ErdGraphEdge, ErdGraphNode } from "./erdGraph";

export type ErdPositions = Record<string, { x: number; y: number }>;

interface LayoutResponse {
  id: string;
  positions?: ErdPositions;
  error?: string;
}

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

export function requestErdLayout(
  nodes: ErdGraphNode[],
  edges: ErdGraphEdge[],
  compact: boolean,
  signal?: AbortSignal,
): Promise<ErdPositions> {
  if (nodes.length === 0) return Promise.resolve({});
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../workers/elkLayout.worker.ts", import.meta.url),
      { type: "module" },
    );
    const id = crypto.randomUUID();
    const abort = () => {
      worker.terminate();
      reject(new DOMException("ERD layout cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      reject(new Error(event.message || "ERD layout worker failed"));
    };
    worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
      if (event.data.id !== id) return;
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.positions ?? {});
    };
    worker.postMessage({
      id,
      nodes: nodes.map((node) => ({
        id: node.id,
        width: 272,
        height: compact
          ? 58
          : Math.min(340, 76 + node.relation.columns.length * 24),
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    });
  });
}
