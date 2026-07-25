// Pure Catalog V2 → ERD graph projection. Physical foreign keys are immutable catalog
// facts; virtual relationships are a separate, explicit overlay and never feed DDL.
import type {
  CatalogObjectRef,
  CatalogRelationV2,
  CatalogSnapshot,
  ErdVirtualRelation,
} from "../ipc/types";

export interface ErdGraphNode {
  id: string;
  relation: CatalogRelationV2;
}

export interface ErdGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceColumns: string[];
  targetColumns: string[];
  label: string;
  virtual: boolean;
}

export interface ErdGraph {
  nodes: ErdGraphNode[];
  edges: ErdGraphEdge[];
  matchedNodeCount: number;
  truncated: boolean;
}

interface ErdIndexedRelation {
  id: string;
  relation: CatalogRelationV2;
  searchText: string;
}

export interface ErdGraphIndex {
  relations: ErdIndexedRelation[];
  relationKeys: ReadonlySet<string>;
  physicalEdges: ErdGraphEdge[];
}

export function erdRelationKey(reference: CatalogObjectRef): string {
  return JSON.stringify([
    reference.catalog,
    reference.namespace,
    reference.name,
    reference.kind,
  ]);
}

function searchable(relation: CatalogRelationV2) {
  return [
    relation.object.catalog,
    relation.object.namespace,
    relation.object.name,
    relation.comment,
    ...relation.columns.flatMap((column) => [
      column.name,
      column.nativeType,
      column.comment,
    ]),
    ...relation.constraints.flatMap((constraint) => [
      constraint.name,
      ...constraint.columns,
      ...constraint.referencedColumns,
    ]),
    ...relation.indexes.flatMap((index) => [
      index.name,
      ...index.keys.flatMap((key) => [key.column, key.expression]),
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

function physicalEdges(
  relations: ErdIndexedRelation[],
  relationKeys: ReadonlySet<string>,
): ErdGraphEdge[] {
  const edges: ErdGraphEdge[] = [];
  for (const indexed of relations) {
    const { relation, id: source } = indexed;
    for (const constraint of relation.constraints) {
      if (constraint.kind !== "foreign" || !constraint.referencedRelation) {
        continue;
      }
      const target = erdRelationKey(constraint.referencedRelation);
      if (!relationKeys.has(target)) continue;
      edges.push({
        id: `physical:${source}:${constraint.name}:${target}`,
        source,
        target,
        sourceColumns: constraint.columns,
        targetColumns: constraint.referencedColumns,
        label: constraint.name,
        virtual: false,
      });
    }
  }
  return edges;
}

function virtualEdges(
  relationKeys: ReadonlySet<string>,
  relations: ErdVirtualRelation[],
): ErdGraphEdge[] {
  return relations.flatMap((relation) => {
    const source = erdRelationKey(relation.fromRelation);
    const target = erdRelationKey(relation.toRelation);
    if (!relationKeys.has(source) || !relationKeys.has(target)) return [];
    return [
      {
        id: `virtual:${relation.id}`,
        source,
        target,
        sourceColumns: relation.fromColumns,
        targetColumns: relation.toColumns,
        label: relation.label?.trim() || "virtual",
        virtual: true,
      },
    ];
  });
}

export function createErdGraphIndex(snapshot: CatalogSnapshot): ErdGraphIndex {
  const relations = snapshot.relations.map((relation) => ({
    id: erdRelationKey(relation.object),
    relation,
    searchText: searchable(relation),
  }));
  const relationKeys = new Set(relations.map((relation) => relation.id));
  return {
    relations,
    relationKeys,
    physicalEdges: physicalEdges(relations, relationKeys),
  };
}

export function buildErdGraph(
  snapshot: CatalogSnapshot,
  virtualRelations: ErdVirtualRelation[],
  options: {
    filter?: string;
    neighborhoodOf?: string | null;
    limit?: number;
    index?: ErdGraphIndex;
  } = {},
): ErdGraph {
  const index = options.index ?? createErdGraphIndex(snapshot);
  const edges = [
    ...index.physicalEdges,
    ...virtualEdges(index.relationKeys, virtualRelations),
  ];
  const filter = options.filter?.trim().toLowerCase() ?? "";
  let visible = new Set(
    index.relations
      .filter((relation) => !filter || relation.searchText.includes(filter))
      .map((relation) => relation.id),
  );

  if (options.neighborhoodOf) {
    const neighborhood = new Set([options.neighborhoodOf]);
    for (const edge of edges) {
      if (edge.source === options.neighborhoodOf) neighborhood.add(edge.target);
      if (edge.target === options.neighborhoodOf) neighborhood.add(edge.source);
    }
    visible = new Set([...visible].filter((key) => neighborhood.has(key)));
  }

  const matchedRelations = index.relations.filter((relation) =>
    visible.has(relation.id),
  );
  const limit =
    options.limit == null
      ? matchedRelations.length
      : Math.max(0, Math.floor(options.limit));
  const visibleRelations = matchedRelations.slice(0, limit);
  const rendered = new Set(visibleRelations.map((relation) => relation.id));

  return {
    nodes: visibleRelations
      .map((indexed) => ({
        id: indexed.id,
        relation: indexed.relation,
      })),
    edges: edges.filter(
      (edge) => rendered.has(edge.source) && rendered.has(edge.target),
    ),
    matchedNodeCount: matchedRelations.length,
    truncated: visibleRelations.length < matchedRelations.length,
  };
}

export function relationDisplayName(reference: CatalogObjectRef): string {
  return reference.namespace
    ? `${reference.namespace}.${reference.name}`
    : reference.name;
}
