// Query's public DTOs are generated from the Rust model/receipt contracts.  Keeping this
// module as the only frontend owner preserves existing imports without a hand-written mirror.
export type {
  Classification,
  PreviewMode,
  PreviewReport,
  RiskLevel,
} from "../../ipc/generated/model";
export type {
  SqlInspection,
  SqlOperationProposal,
} from "./generated/contracts";

// Desktop-only channel payload. Broker, CLI, dashboard, and legacy run receipts
// deliberately keep their bounded materialized contract.
export type SqlStreamBatch = {
  operationId: string;
  sequence: number;
  columns: string[];
  rows: unknown[][];
};

/** Small Channel notification; row data is pulled with this exact capability. */
export type SqlStreamReady = {
  operationId: string;
  sequence: number;
  capability: string;
};

/** Capability-bound cancellation supplied only after the owning ready event. */
export type SqlStreamCancellation = {
  operationId: string;
  capability: string;
  cancel: () => Promise<void>;
};

export type SqlStreamBatchHandler = (
  batch: SqlStreamBatch,
  cancellation: SqlStreamCancellation,
) => void | Promise<void>;

/** Returned synchronously so callers can cancel before the first ready event. */
export type SqlStreamController = {
  completion: Promise<SqlStreamReceipt>;
  cancel: () => Promise<void>;
};

export type SqlStreamReceipt = {
  operationId: string;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
};
