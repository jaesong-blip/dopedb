// Reduces query-owned runtime state to one content-free product event per
// manual attempt. SQL is consumed only by the lossy statement classifier; raw
// SQL and statement errors never enter retained analytics state or the wire.
import { useEffect, useRef, useState } from "react";

import type { ScriptOutcome } from "../../ipc/types";
import type { CatalogScope } from "../../lib/queries";
import {
  captureProductEvent,
  captureProductEventOncePerSession,
} from "../productAnalytics/client";
import type {
  ProductAnalyticsWorkspaceContextInput,
  ProductEventPropertiesByName,
} from "../productAnalytics/domain";
import {
  productAnalyticsAccessMode,
  productAnalyticsConnectionEngine,
  productAnalyticsDurationBucket,
  productAnalyticsRowCountBucket,
  productAnalyticsStatementClass,
  productAnalyticsWorkspaceContext,
} from "../productAnalytics/outcomes";
import type {
  ConnectionEngine,
  WorkspaceCredentialMode,
} from "../connections/domain";
import type { SqlStreamPhase } from "./domain";

type QueryProperties =
  ProductEventPropertiesByName["query_execution_completed"];
type QueryOutcome = QueryProperties["outcome"];

export type QueryExecutionAnalyticsAttempt = {
  dedupeId: string;
  context: ProductAnalyticsWorkspaceContextInput;
  startedAtMs: number;
  statementClass: QueryProperties["statementClass"];
  previousStreamRunId: number;
  approvalRequired: boolean;
  sharedAccess: ProductEventPropertiesByName["shared_connection_access_ready"] | null;
  armed: boolean;
  completed: boolean;
};

export type ScriptProductAnalyticsSummary = {
  outcome: Extract<QueryOutcome, "success" | "failed">;
  rowCount: number | null;
};

type QueryExecutionAnalyticsState = {
  scope: CatalogScope;
  connectionEngine: ConnectionEngine;
  credentialMode: WorkspaceCredentialMode;
  cancelled: boolean;
  failed: boolean;
  materializedCompleted: boolean;
  materializedRowCount: number | null;
  materializedDurationMs: number | null;
  scriptOutcome: Extract<QueryOutcome, "success" | "failed"> | null;
  scriptRowCount: number | null;
  streamRunId: number;
  streamOutcome: QueryOutcome | null;
  streamRowCount: number;
  streamDurationMs: number | null;
};

export function scriptProductAnalyticsSummary(
  outcome: ScriptOutcome,
): ScriptProductAnalyticsSummary {
  const failed = outcome.statements.some(
    (statement) => statement.error !== null,
  );
  let rowCount = 0;
  let hasResult = false;
  for (const statement of outcome.statements) {
    const statementRows = statement.result?.rowCount;
    if (statementRows === undefined) continue;
    hasResult = true;
    rowCount += statementRows;
    if (!Number.isSafeInteger(rowCount)) {
      return { outcome: failed ? "failed" : "success", rowCount: null };
    }
  }
  return {
    outcome: failed ? "failed" : "success",
    rowCount: hasResult ? rowCount : null,
  };
}

export function streamProductAnalyticsOutcome(
  phase: SqlStreamPhase,
): QueryOutcome | null {
  if (phase === "complete") return "success";
  if (phase === "cancelled") return "cancelled";
  if (phase === "error") return "failed";
  if (phase === "outcome_unknown") return "unknown";
  return null;
}

function recordOutcome(
  attempt: QueryExecutionAnalyticsAttempt,
  outcome: QueryOutcome,
  rowCount: number | null,
  durationMs: number,
) {
  if (attempt.completed) return;
  attempt.completed = true;
  void captureProductEvent({
    name: "query_execution_completed",
    dedupeId: attempt.dedupeId,
    context: attempt.context,
    properties: {
      outcome,
      statementClass: attempt.statementClass,
      rowCountBucket: productAnalyticsRowCountBucket(rowCount),
      durationBucket: productAnalyticsDurationBucket(durationMs),
      approvalRequired: attempt.approvalRequired,
    },
  });
  if (
    outcome === "success" &&
    attempt.context.workspaceKind === "team" &&
    attempt.sharedAccess
  ) {
    void captureProductEventOncePerSession({
      name: "shared_connection_access_ready",
      context: attempt.context,
      properties: attempt.sharedAccess,
    });
  }
}

export function useQueryExecutionAnalytics({
  scope,
  cancelled,
  failed,
  materializedCompleted,
  materializedRowCount,
  materializedDurationMs,
  scriptOutcome,
  scriptRowCount,
  streamRunId,
  streamOutcome,
  streamRowCount,
  streamDurationMs,
  connectionEngine,
  credentialMode,
}: QueryExecutionAnalyticsState) {
  const attemptRef = useRef<QueryExecutionAnalyticsAttempt | null>(null);
  const [terminalRevision, setTerminalRevision] = useState(0);

  useEffect(() => {
    const attempt = attemptRef.current;
    if (!attempt || !attempt.armed || attempt.completed) return;
    const currentStream = streamRunId > attempt.previousStreamRunId;
    let outcome: QueryOutcome | null = null;
    if (currentStream && streamOutcome === "unknown") outcome = "unknown";
    else if (
      cancelled ||
      (currentStream && streamOutcome === "cancelled")
    ) {
      outcome = "cancelled";
    } else if (failed || (currentStream && streamOutcome === "failed")) {
      outcome = "failed";
    } else if (scriptOutcome) outcome = scriptOutcome;
    else if (
      materializedCompleted ||
      (currentStream && streamOutcome === "success")
    ) {
      outcome = "success";
    }
    if (!outcome) return;

    const rowCount = outcome !== "success"
      ? null
      : currentStream && streamOutcome === "success"
        ? streamRowCount
        : materializedCompleted
          ? materializedRowCount
          : scriptRowCount;
    const measuredDurationMs = currentStream && streamDurationMs !== null
      ? streamDurationMs
      : materializedDurationMs;
    recordOutcome(
      attempt,
      outcome,
      rowCount,
      measuredDurationMs ?? Math.max(0, Date.now() - attempt.startedAtMs),
    );
  }, [
    cancelled,
    failed,
    materializedCompleted,
    materializedDurationMs,
    materializedRowCount,
    scriptOutcome,
    scriptRowCount,
    streamDurationMs,
    streamOutcome,
    streamRowCount,
    streamRunId,
    terminalRevision,
  ]);

  function begin(sql: string, previousStreamRunId: number) {
    const previous = attemptRef.current;
    if (previous && !previous.completed) {
      // Replacing or unmounting a UI owner is not a database terminal receipt.
      // Stop observing rather than misclassifying a write that may still commit.
      previous.completed = true;
    }
    const context = productAnalyticsWorkspaceContext(scope);
    const attempt: QueryExecutionAnalyticsAttempt | null = context
      ? {
          dedupeId: crypto.randomUUID(),
          context,
          startedAtMs: Date.now(),
          statementClass: productAnalyticsStatementClass(sql),
          previousStreamRunId,
          approvalRequired: false,
          sharedAccess: context.workspaceKind === "team"
            ? {
                accessMode: productAnalyticsAccessMode(credentialMode),
                engine: productAnalyticsConnectionEngine(connectionEngine),
              }
            : null,
          armed: false,
          completed: false,
        }
      : null;
    attemptRef.current = attempt;
    return attempt;
  }

  function arm(attempt: QueryExecutionAnalyticsAttempt | null) {
    if (!attempt || attemptRef.current !== attempt || attempt.armed) return;
    attempt.armed = true;
    setTerminalRevision((revision) => revision + 1);
  }

  function disarm(attempt: QueryExecutionAnalyticsAttempt | null) {
    if (attempt && attemptRef.current === attempt) attempt.armed = false;
  }

  function requireApproval(attempt: QueryExecutionAnalyticsAttempt | null) {
    if (attempt && attemptRef.current === attempt) {
      attempt.approvalRequired = true;
    }
  }

  return { arm, begin, disarm, requireApproval };
}
