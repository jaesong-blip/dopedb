import { invoke } from "../../ipc/core";

import type { QueryResult } from "../../ipc/types";
import type { ConnectionId } from "../connections/domain";
import type {
  Dashboard,
  DashboardId,
  QueryExecutionId,
} from "./domain";

export function listDashboards(connectionId: ConnectionId): Promise<Dashboard[]> {
  return invoke("list_dashboards", { connectionId });
}

export function deleteDashboard(id: DashboardId): Promise<void> {
  return invoke("delete_dashboard", { id });
}

export function runDashboard(
  id: DashboardId,
  queryId?: QueryExecutionId,
): Promise<QueryResult> {
  return invoke("run_dashboard", { id, queryId: queryId ?? null });
}
