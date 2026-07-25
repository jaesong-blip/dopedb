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

export interface Dashboard {
  id: DashboardId;
  connectionId: ConnectionId;
  title: string;
  description: string;
  sql: string;
  visualization: DashboardVisualization;
  createdAt: string;
  updatedAt: string;
}
