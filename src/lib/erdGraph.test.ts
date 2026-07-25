import { describe, expect, it } from "vitest";
import type {
  CatalogObjectRef,
  CatalogRelationV2,
  CatalogSnapshot,
} from "../ipc/types";
import {
  erdVirtualRelationId,
  type ErdVirtualRelation,
} from "../features/erd/domain";
import {
  buildErdGraph,
  createErdGraphIndex,
  erdRelationKey,
} from "./erdGraph";

function reference(name: string): CatalogObjectRef {
  return {
    catalog: null,
    namespace: "public",
    name,
    kind: "table",
    nativeId: null,
  };
}

function relation(name: string): CatalogRelationV2 {
  return {
    object: reference(name),
    comment: null,
    rowEstimate: null,
    partitionParent: null,
    partitionChildren: [],
    columns: [],
    constraints: [],
    indexes: [],
  };
}

function snapshot(relations: CatalogRelationV2[]): CatalogSnapshot {
  return {
    schemaVersion: 2,
    connectionId: "connection",
    engine: "postgres",
    database: "app",
    capturedAt: "2026-07-25T00:00:00Z",
    fingerprint: "a".repeat(64),
    namespaces: [{ name: "public", comment: null }],
    relations,
    routines: [],
    otherObjects: [],
  };
}

describe("ERD graph projection", () => {
  it("keeps physical and virtual relationships visually distinct", () => {
    const users = relation("users");
    const teams = relation("teams");
    users.constraints.push({
      name: "users_team_fk",
      kind: "foreign",
      columns: ["team_id"],
      referencedRelation: teams.object,
      referencedColumns: ["id"],
      checkExpression: null,
      updateAction: null,
      deleteAction: null,
      deferrable: false,
      validated: true,
    });
    const virtual: ErdVirtualRelation = {
      id: erdVirtualRelationId("01900000-0000-7000-8000-000000000001"),
      fromRelation: teams.object,
      fromColumns: ["owner_id"],
      toRelation: users.object,
      toColumns: ["id"],
      label: "logical owner",
    };

    const graph = buildErdGraph(snapshot([users, teams]), [virtual]);

    expect(graph.edges.map((edge) => edge.virtual)).toEqual([false, true]);
    expect(graph.edges[1]).toMatchObject({
      sourceColumns: ["owner_id"],
      targetColumns: ["id"],
      label: "logical owner",
    });
  });

  it("limits neighborhood mode to the selected relation and direct neighbors", () => {
    const users = relation("users");
    const teams = relation("teams");
    const logs = relation("logs");
    users.constraints.push({
      name: "users_team_fk",
      kind: "foreign",
      columns: ["team_id"],
      referencedRelation: teams.object,
      referencedColumns: ["id"],
      checkExpression: null,
      updateAction: null,
      deleteAction: null,
      deferrable: false,
      validated: true,
    });

    const graph = buildErdGraph(snapshot([users, teams, logs]), [], {
      neighborhoodOf: erdRelationKey(users.object),
    });

    expect(graph.nodes.map((node) => node.relation.object.name).sort()).toEqual([
      "teams",
      "users",
    ]);
  });

  it("caps rendered nodes while retaining the full match count", () => {
    const catalog = snapshot([
      relation("a"),
      relation("b"),
      relation("c"),
    ]);
    const index = createErdGraphIndex(catalog);
    const graph = buildErdGraph(catalog, [], { index, limit: 2 });

    expect(graph.nodes.map((node) => node.relation.object.name)).toEqual([
      "a",
      "b",
    ]);
    expect(graph.matchedNodeCount).toBe(3);
    expect(graph.truncated).toBe(true);
  });
});
