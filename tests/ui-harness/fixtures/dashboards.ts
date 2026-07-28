// Dashboard fixture는 saved query의 선언적 결과만 표현한다. 실제 database나
// network endpoint 없이 수동 실행 한 번에 고정된 QueryResult를 돌려준다.
import type { QueryResult } from "../../../src/ipc/types";
import {
  dashboardId,
  type Dashboard,
} from "../../../src/features/dashboards/domain";
import { connectionId } from "../../../src/features/connections/domain";
import { analyticsPostgres } from "./connections";

export const revenueDashboard = {
  id: dashboardId("fixture-dashboard-revenue"),
  connectionId: connectionId(analyticsPostgres.id),
  title: "Monthly revenue",
  description: "Fixture revenue trend for the review harness",
  sql: "SELECT month, revenue FROM monthly_revenue ORDER BY month",
  visualization: {
    version: 1,
    kind: "line",
    xColumn: "month",
    yColumns: ["revenue"],
  },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-28T08:30:00.000Z",
} satisfies Dashboard;

export const orderStatusDashboard = {
  id: dashboardId("fixture-dashboard-status"),
  connectionId: connectionId(analyticsPostgres.id),
  title: "Orders by status",
  description: "Fixture status distribution",
  sql: "SELECT status, count(*) AS orders FROM orders GROUP BY status",
  visualization: {
    version: 1,
    kind: "bar",
    xColumn: "status",
    yColumns: ["orders"],
  },
  createdAt: "2026-07-02T00:00:00.000Z",
  updatedAt: "2026-07-28T08:32:00.000Z",
} satisfies Dashboard;

export const fixtureDashboards = [
  revenueDashboard,
  orderStatusDashboard,
] satisfies Dashboard[];

export const revenueDashboardResult = {
  columns: ["month", "revenue"],
  rows: [
    ["2026-04-01", "724100.25"],
    ["2026-05-01", "781442.80"],
    ["2026-06-01", "842194.55"],
  ],
  rowCount: 3,
  truncated: false,
  durationMs: 24,
} satisfies QueryResult;
