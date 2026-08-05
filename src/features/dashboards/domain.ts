/** Saved-dashboard identities and declarative visualization values. */

import type { ConnectionId } from "../connections/domain";

declare const dashboardIdBrand: unique symbol;
declare const queryExecutionIdBrand: unique symbol;

export type DashboardId = string & {
  readonly [dashboardIdBrand]: "DashboardId";
};

export type QueryExecutionId = string & {
  readonly [queryExecutionIdBrand]: "QueryExecutionId";
};

export function dashboardId(value: string): DashboardId {
  return value as DashboardId;
}

export function queryExecutionId(value: string): QueryExecutionId {
  return value as QueryExecutionId;
}

export type DashboardKind = "auto" | "metric" | "line" | "bar" | "table";

export interface DashboardVisualization {
  version: 1;
  kind: DashboardKind;
  xColumn: string | null;
  yColumns: string[];
}

export type DashboardState = "draft" | "published" | "archived";
export type DashboardSyncStatus = "local" | "dirty" | "synced" | "conflict";

export interface Dashboard {
  id: DashboardId;
  connectionId: ConnectionId;
  title: string;
  description: string;
  sql: string;
  visualization: DashboardVisualization;
  state: DashboardState;
  syncStatus: DashboardSyncStatus;
  ownerMemberId: string | null;
  updatedByMemberId: string | null;
  revision: number;
  remoteRevision: number | null;
  createdAt: string;
  updatedAt: string;
}
