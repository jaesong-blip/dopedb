// ELK adapter tests cover real worker protocol integration boundaries without running
// the 1.5 MB layout worker inside Vitest.
import { describe, expect, it } from "vitest";
import type {
  CatalogObjectRef,
  CatalogRelationV2,
} from "../ipc/types";
import type { ErdGraphNode } from "./erdGraph";
import {
  fallbackErdPositions,
  requestErdLayout,
} from "./erdLayout";

function relation(name: string): CatalogRelationV2 {
  const object: CatalogObjectRef = {
    catalog: null,
    namespace: "public",
    name,
    kind: "table",
    nativeId: null,
  };
  return {
    object,
    comment: null,
    rowEstimate: null,
    partitionParent: null,
    partitionChildren: [],
    columns: [],
    constraints: [],
    indexes: [],
  };
}

function nodes(...names: string[]): ErdGraphNode[] {
  return names.map((name) => ({
    id: name,
    relation: relation(name),
  }));
}

describe("ERD layout worker adapter", () => {
  it("uses deterministic positions when the worker constructor is unavailable", async () => {
    const graphNodes = nodes("users", "teams", "events");
    const result = await requestErdLayout(
      graphNodes,
      [],
      true,
      undefined,
      () => {
        throw new TypeError("Worker is unavailable");
      },
    );

    expect(result).toEqual({
      positions: fallbackErdPositions(graphNodes),
      fallback: true,
    });
  });

  it("rejects an already cancelled layout without constructing a worker", async () => {
    const controller = new AbortController();
    controller.abort();
    let constructed = false;

    await expect(
      requestErdLayout(nodes("users"), [], true, controller.signal, () => {
        constructed = true;
        throw new Error("must not run");
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(constructed).toBe(false);
  });
});
