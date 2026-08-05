import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";

import type { ConnectionProfile } from "../connections/domain";
import type { QueryServiceSession } from "../queryServices/domain";
import type { AcpSessionSummary } from "../agents/domain";
import {
  cancelAgentAcpSession,
  listAgentAcpSessions,
  onAgentAcpChanged,
} from "../agents/tauriAdapter";
import type { Job } from "../jobs/domain";
import { cancelJob } from "../jobs/tauriAdapter";
import { jobsQuery, qk } from "../../lib/queries";
import { usePostPaintReady } from "../../lib/usePostPaintReady";
import type { BackgroundTask, BackgroundTaskStatus } from "./domain";

const ACTIVE_JOB_STATES = new Set<Job["state"]>([
  "running",
  "pause_requested",
  "paused",
  "cancel_requested",
]);

const ACTIVE_AGENT_STATES = new Set<AcpSessionSummary["lifecycle"]>([
  "starting",
  "running",
  "waitingPermission",
]);

function mergeAgentSessions(
  current: AcpSessionSummary[],
  incoming: AcpSessionSummary[],
) {
  const merged = new Map(current.map((session) => [session.id, session]));
  for (const session of incoming) {
    const existing = merged.get(session.id);
    if (!existing || existing.updatedAt <= session.updatedAt) {
      merged.set(session.id, session);
    }
  }
  return [...merged.values()];
}

function jobProgress(job: Job) {
  if (job.rowsTotal && job.rowsTotal > 0) {
    return Math.min(100, (job.rowsProcessed / job.rowsTotal) * 100);
  }
  if (job.bytesTotal && job.bytesTotal > 0) {
    return Math.min(100, (job.bytesProcessed / job.bytesTotal) * 100);
  }
  return null;
}

function jobStatus(state: Job["state"]): BackgroundTaskStatus {
  if (state === "pause_requested") return "pausing";
  if (state === "paused") return "paused";
  if (state === "cancel_requested") return "cancelling";
  return "running";
}

function agentStatus(
  lifecycle: AcpSessionSummary["lifecycle"],
): BackgroundTaskStatus {
  if (lifecycle === "starting") return "starting";
  if (lifecycle === "waitingPermission") return "waitingPermission";
  return "running";
}

export function useBackgroundTasks({
  connections,
  querySessions,
  workspaceScopeKey,
}: {
  connections: ConnectionProfile[];
  querySessions: QueryServiceSession[];
  workspaceScopeKey: string;
}) {
  const queryClient = useQueryClient();
  const postPaintReady = usePostPaintReady();
  const [agentSessions, setAgentSessions] = useState<AcpSessionSummary[]>([]);
  const [cancellingKeys, setCancellingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const jobQueries = useQueries({
    queries: connections.map((connection) => ({
      ...jobsQuery(connection.id),
      enabled: postPaintReady,
    })),
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    setAgentSessions([]);
    if (!postPaintReady) return;

    void onAgentAcpChanged((change) => {
      if (disposed) return;
      setAgentSessions((current) =>
        mergeAgentSessions(current, [change.session])
      );
    })
      .then((stopListening) => {
        if (disposed) {
          stopListening();
          return;
        }
        unlisten = stopListening;
      })
      .catch(() => {});

    void listAgentAcpSessions()
      .then((loaded) => {
        if (!disposed) {
          setAgentSessions((current) => mergeAgentSessions(current, loaded));
        }
      })
      .catch(() => {
        // The Agent panel owns detailed load errors. The
        // status bar remains a truthful projection of the tasks it can observe.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [postPaintReady, workspaceScopeKey]);

  const tasks = useMemo(() => {
    const connectionNames = new Map(
      connections.map((connection) => [
        connection.id as string,
        connection.name || connection.database,
      ]),
    );
    const queryTasks: BackgroundTask[] = querySessions.flatMap((session) => {
      if (session.status !== "running" && session.status !== "waiting") {
        return [];
      }
      return [{
        kind: "query",
        key: `query:${session.id}`,
        sessionId: session.id,
        connectionId: session.connectionId,
        connectionName:
          connectionNames.get(session.connectionId) ||
          session.connectionName,
        title: session.consoleTitle,
        status:
          session.status === "waiting" ? "waitingApproval" : "running",
        progress: null,
        rowsProcessed: null,
        updatedAt: session.updatedAt,
        cancellable: false,
      }];
    });
    const agentTasks: BackgroundTask[] = agentSessions.flatMap((session) => {
      if (!ACTIVE_AGENT_STATES.has(session.lifecycle)) return [];
      return [{
        kind: "agent",
        key: `agent:${session.id}`,
        sessionId: session.id,
        connectionId: session.connectionId,
        connectionName:
          connectionNames.get(session.connectionId) || session.connectionId,
        title: session.title,
        status: agentStatus(session.lifecycle),
        progress: null,
        rowsProcessed: null,
        updatedAt: Date.parse(session.updatedAt) || 0,
        cancellable: true,
      }];
    });
    const jobTasks: BackgroundTask[] = jobQueries.flatMap((query) =>
      (query.data ?? []).flatMap((job) => {
        if (!ACTIVE_JOB_STATES.has(job.state)) return [];
        return [{
          kind: "job",
          key: `job:${job.id}`,
          jobId: job.id,
          connectionId: job.connectionId,
          connectionName:
            connectionNames.get(job.connectionId) || job.connectionId,
          title:
            job.kind === "export"
              ? job.targetSummary
              : job.sourceSummary,
          status: jobStatus(job.state),
          progress: jobProgress(job),
          rowsProcessed: job.rowsProcessed,
          updatedAt: Date.parse(job.updatedAt) || 0,
          operation: job.kind,
          cancellable: job.state !== "cancel_requested",
        }];
      })
    );

    return [...queryTasks, ...agentTasks, ...jobTasks].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
  }, [agentSessions, connections, jobQueries, querySessions]);

  const cancelTask = useCallback(
    async (task: BackgroundTask) => {
      if (!task.cancellable || cancellingKeys.has(task.key)) return;
      setCancellingKeys((current) => new Set(current).add(task.key));
      try {
        if (task.kind === "agent") {
          await cancelAgentAcpSession(task.sessionId);
        } else if (task.kind === "job") {
          await cancelJob(task.connectionId, task.jobId);
          await queryClient.invalidateQueries({
            queryKey: qk.jobs(task.connectionId),
          });
        }
      } finally {
        setCancellingKeys((current) => {
          const next = new Set(current);
          next.delete(task.key);
          return next;
        });
      }
    },
    [cancellingKeys, queryClient],
  );

  return {
    tasks,
    cancellingKeys,
    cancelTask,
  };
}
