import type {
  AppErrorDetails,
  ExecOutcome,
  ScriptOutcome,
} from "../../ipc/types";
import type { SqlStreamViewState } from "../queries/domain";

export type QueryServiceStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type QueryServiceError = AppErrorDetails & {
  sql: string;
  at: string;
};

export type QueryServiceResult =
  | { kind: "none" }
  | {
      kind: "materialized";
      sql: string;
      outcome: ExecOutcome;
      at: string;
      maxRows: number;
    }
  | {
      kind: "stream";
      sql: string;
      stream: SqlStreamViewState;
      maxRows: number;
    }
  | {
      kind: "script";
      outcome: ScriptOutcome;
      at: string;
    }
  | {
      kind: "error";
      error: QueryServiceError;
      prompt: string;
    };

export type QueryServiceSession = {
  id: string;
  documentId: string;
  connectionId: string;
  connectionName: string;
  consoleTitle: string;
  database: string;
  namespace: string;
  sql: string;
  startedAt: string;
  startedLabel: string;
  updatedAt: number;
  status: QueryServiceStatus;
  result: QueryServiceResult;
};

let sessionSequence = 0;

export function nextQueryServiceSessionId(documentId: string) {
  sessionSequence += 1;
  return `${documentId}:${Date.now()}:${sessionSequence}`;
}
