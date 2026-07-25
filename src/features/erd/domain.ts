/** ERD persistence contracts. Physical relationships always come from Catalog V2. */

import type { CatalogObjectRef } from "../../ipc/types";
import type { ConnectionId } from "../connections/domain";

declare const erdLayoutIdBrand: unique symbol;
declare const erdVirtualRelationIdBrand: unique symbol;

export type ErdLayoutId = string & {
  readonly [erdLayoutIdBrand]: "ErdLayoutId";
};

export type ErdVirtualRelationId = string & {
  readonly [erdVirtualRelationIdBrand]: "ErdVirtualRelationId";
};

export function erdLayoutId(value: string): ErdLayoutId {
  return value as ErdLayoutId;
}

export function erdVirtualRelationId(value: string): ErdVirtualRelationId {
  return value as ErdVirtualRelationId;
}

export type ErdLayoutMode = "physical" | "logical" | "uml";

export interface ErdNodePosition {
  relationKey: string;
  x: number;
  y: number;
}

export interface ErdViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ErdCanvasLayout {
  nodes: ErdNodePosition[];
  viewport: ErdViewport;
  compact: boolean;
  hiddenRelationKeys: string[];
}

export interface ErdVirtualRelation {
  id: ErdVirtualRelationId;
  fromRelation: CatalogObjectRef;
  fromColumns: string[];
  toRelation: CatalogObjectRef;
  toColumns: string[];
  label: string | null;
}

export interface ErdLayout {
  id: ErdLayoutId;
  connectionId: ConnectionId;
  name: string;
  mode: ErdLayoutMode;
  catalogFingerprint: string;
  layout: ErdCanvasLayout;
  virtualRelations: ErdVirtualRelation[];
  revision: number;
  remoteId: string | null;
  remoteRevision: number | null;
  syncStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveErdLayoutRequest {
  id?: ErdLayoutId | null;
  connectionId: ConnectionId;
  name: string;
  mode: ErdLayoutMode;
  catalogFingerprint: string;
  layout: ErdCanvasLayout;
  virtualRelations: ErdVirtualRelation[];
  expectedRevision?: number | null;
}

export interface SaveErdLayoutOutcome {
  saved: boolean;
  layout: ErdLayout;
}
