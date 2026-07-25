// ELK runs off the renderer thread so a thousand-table schema cannot freeze typing,
// scrolling, or cancellation controls while automatic layout is calculated.
import ELK from "elkjs/lib/elk.bundled.js";

interface LayoutRequest {
  id: string;
  nodes: Array<{ id: string; width: number; height: number }>;
  edges: Array<{ id: string; source: string; target: string }>;
}

interface LayoutResponse {
  id: string;
  positions?: Record<string, { x: number; y: number }>;
  error?: string;
}

const elk = new ELK();

self.onmessage = async (event: MessageEvent<LayoutRequest>) => {
  const request = event.data;
  try {
    const graph = await elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.spacing.nodeNodeBetweenLayers": "96",
        "elk.spacing.nodeNode": "56",
        "elk.spacing.edgeNode": "24",
      },
      children: request.nodes.map((node) => ({
        id: node.id,
        width: node.width,
        height: node.height,
      })),
      edges: request.edges.map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
    });
    const positions = Object.fromEntries(
      (graph.children ?? []).map((node) => [
        node.id,
        { x: node.x ?? 0, y: node.y ?? 0 },
      ]),
    );
    self.postMessage({ id: request.id, positions } satisfies LayoutResponse);
  } catch (cause) {
    self.postMessage({
      id: request.id,
      error: cause instanceof Error ? cause.message : String(cause),
    } satisfies LayoutResponse);
  }
};
