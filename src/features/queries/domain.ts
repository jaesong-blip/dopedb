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

export type ManualTransactionStatus = {
  transactionId: string;
  connectionId: string;
  database: string;
  phase: "active" | "failed";
  statementCount: number;
  startedAt: string;
  expiresAt: string;
};

// The SQL screen is the single writer for a desktop stream.  Keeping the reducer
// with the transport DTOs makes stale-run and sequence validation testable without
// giving a component permission to acknowledge a batch before it is accepted.
export type SqlStreamPhase =
  | "idle"
  | "connecting"
  | "streaming"
  | "complete"
  | "cancelled"
  | "error"
  | "outcome_unknown";

export type SqlStreamViewState = {
  runId: number;
  phase: SqlStreamPhase;
  operationId: string | null;
  nextSequence: number;
  columns: string[];
  rowSource: SqlStreamRowSource;
  rowCount: number;
  truncated: boolean;
  durationMs: number | null;
  error: string | null;
};

/** Snapshot view over an append-only, random-access chunk index. */
export type SqlStreamRowSource = {
  /**
   * A deliberately shared, append-only index.  The SQL stream reducer is its
   * only writer; each source carries its own row-count snapshot, so older
   * renders cannot read rows appended by a newer render.  This avoids copying
   * the whole chunk index for every 256-row Channel page.
   */
  chunkIndex: SqlStreamChunkIndex;
  rowCount: number;
};

/** A batch's stable range in its owner's append-only index. */
export type SqlStreamRowChunk = {
  start: number;
  rows: readonly unknown[][];
};

/** Owned by one stream reducer; consumers must treat it as append-only. */
export type SqlStreamChunkIndex = {
  chunks: SqlStreamRowChunk[];
};

export const SQL_STREAM_MAX_ROWS_PER_BATCH = 256;

export function emptySqlStreamRows(): SqlStreamRowSource {
  return { chunkIndex: { chunks: [] }, rowCount: 0 };
}

export function appendSqlStreamRows(
  source: SqlStreamRowSource,
  rows: readonly unknown[][],
): SqlStreamRowSource {
  if (!rows.length) return source;
  // `chunkIndex` is intentionally not persistent. The stream reducer is the
  // single writer and every returned source has a fixed `rowCount` snapshot.
  // Appending is therefore amortized O(1), while row lookup remains O(log B).
  source.chunkIndex.chunks.push({ start: source.rowCount, rows });
  return {
    chunkIndex: source.chunkIndex,
    rowCount: source.rowCount + rows.length,
  };
}

export function sqlStreamRowAt(
  source: SqlStreamRowSource,
  index: number,
): readonly unknown[] | undefined {
  if (index < 0 || index >= source.rowCount) return undefined;
  let low = 0;
  const chunks = source.chunkIndex.chunks;
  let high = chunks.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const chunk = chunks[middle];
    if (index < chunk.start) high = middle - 1;
    else if (
      index >= Math.min(chunk.start + chunk.rows.length, source.rowCount)
    )
      low = middle + 1;
    else return chunk.rows[index - chunk.start];
  }
  return undefined;
}

export function* iterateSqlStreamRows(
  source: SqlStreamRowSource,
): Generator<readonly unknown[]> {
  for (const chunk of source.chunkIndex.chunks) {
    const remaining = source.rowCount - chunk.start;
    if (remaining <= 0) return;
    for (let index = 0; index < Math.min(chunk.rows.length, remaining); index += 1)
      yield chunk.rows[index];
  }
}

export function emptySqlStreamView(runId = 0): SqlStreamViewState {
  return {
    runId,
    phase: "idle",
    operationId: null,
    nextSequence: 0,
    columns: [],
    rowSource: emptySqlStreamRows(),
    rowCount: 0,
    truncated: false,
    durationMs: null,
    error: null,
  };
}

function sameColumns(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((column, index) => column === right[index])
  );
}

/** Accept exactly the next bounded batch; callers ACK only after this returns true. */
export function acceptSqlStreamBatch(
  state: SqlStreamViewState,
  runId: number,
  batch: SqlStreamBatch,
): SqlStreamViewState | null {
  if (
    state.runId !== runId ||
    state.phase !== "connecting" && state.phase !== "streaming"
  )
    return null;
  if (
    batch.sequence !== state.nextSequence ||
    batch.rows.length > SQL_STREAM_MAX_ROWS_PER_BATCH
  )
    return null;
  if (state.operationId && state.operationId !== batch.operationId) return null;
  if (batch.rows.some((row) => row.length !== batch.columns.length))
    return null;
  if (state.columns.length && !sameColumns(state.columns, batch.columns))
    return null;
  return {
    ...state,
    phase: "streaming",
    operationId: batch.operationId,
    nextSequence: state.nextSequence + 1,
    columns: state.columns.length ? state.columns : [...batch.columns],
    rowSource: appendSqlStreamRows(state.rowSource, batch.rows),
    rowCount: state.rowCount + batch.rows.length,
  };
}

export function finishSqlStream(
  state: SqlStreamViewState,
  runId: number,
  receipt: SqlStreamReceipt,
): SqlStreamViewState {
  if (
    state.runId !== runId ||
    (state.phase !== "connecting" && state.phase !== "streaming")
  )
    return state;
  if (
    (state.operationId !== null && state.operationId !== receipt.operationId) ||
    state.rowCount !== receipt.rowCount
  ) {
    return {
      ...state,
      phase: "outcome_unknown",
      error: "stream completion receipt did not match accepted batches",
    };
  }
  return {
    ...state,
    phase: "complete",
    operationId: receipt.operationId,
    rowCount: receipt.rowCount,
    truncated: receipt.truncated,
    durationMs: receipt.durationMs,
  };
}
