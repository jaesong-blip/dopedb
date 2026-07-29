import type { AcpSessionId } from "../agents/domain";
import type { ConnectionId as AgentConnectionId } from "../connections/domain";
import type {
  ConnectionId as JobConnectionId,
  JobId,
} from "../jobs/domain";

export type BackgroundTaskStatus =
  | "starting"
  | "running"
  | "waitingApproval"
  | "waitingPermission"
  | "pausing"
  | "paused"
  | "cancelling";

type BackgroundTaskBase = {
  key: string;
  connectionId: string;
  connectionName: string;
  title: string;
  status: BackgroundTaskStatus;
  progress: number | null;
  rowsProcessed: number | null;
  updatedAt: number;
};

export type BackgroundTask =
  | (BackgroundTaskBase & {
      kind: "query";
      sessionId: string;
      cancellable: false;
    })
  | (BackgroundTaskBase & {
      kind: "agent";
      sessionId: AcpSessionId;
      connectionId: AgentConnectionId;
      cancellable: true;
    })
  | (BackgroundTaskBase & {
      kind: "job";
      jobId: JobId;
      connectionId: JobConnectionId;
      operation: "import" | "export";
      cancellable: boolean;
    });
