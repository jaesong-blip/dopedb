// The only frontend module that owns SQL query command literals and their camelCase wire shape.
// Mutating execution stays behind the explicit proposal/approval/run flow.

import { Channel, invoke } from "@tauri-apps/api/core";

import type { ExecOutcome } from "../../ipc/types";
import type {
  SqlInspection,
  SqlOperationProposal,
  SqlStreamBatch,
  SqlStreamBatchHandler,
  SqlStreamController,
  SqlStreamReady,
  SqlStreamReceipt,
} from "./domain";

export function inspectSql(id: string, sql: string): Promise<SqlInspection> {
  return invoke("inspect_sql", { id, sql });
}

export function proposeSql(
  id: string,
  sql: string,
  origin?: string,
): Promise<SqlOperationProposal> {
  return invoke("propose_sql", {
    id,
    sql,
    origin: origin ?? null,
  });
}

export function runSql(operationId: string): Promise<ExecOutcome> {
  return invoke("run_sql", { operationId });
}

/** Stream an already-planned desktop read in bounded channel batches. */
export function runSqlStream(
  operationId: string,
  onBatch: SqlStreamBatchHandler,
): SqlStreamController {
  return startSqlStream(operationId, onBatch, (capability, onRows) =>
    invoke<SqlStreamReceipt>("run_sql_stream", { operationId, capability, onRows }));
}

function newStreamCapability(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function startSqlStream(
  operationId: string,
  onBatch: SqlStreamBatchHandler,
  start: (
    capability: string,
    onRows: Channel<SqlStreamReady>,
  ) => Promise<SqlStreamReceipt>,
): SqlStreamController {
  const capability = newStreamCapability();
  let activeOperationId = operationId;
  let cancelled = false;
  let readyQueue = Promise.resolve();
  const onRows = new Channel<SqlStreamReady>();
  const sendCancellation = () => invoke("cancel_sql_stream", {
    operationId: activeOperationId || null,
    capability,
  });
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    await sendCancellation();
  };
  onRows.onmessage = (ready) => {
    activeOperationId = ready.operationId;
    readyQueue = readyQueue.then(() => pullAcceptAndAcknowledgeStreamBatch(
      ready, onBatch, () => cancelled, cancel, sendCancellation,
    ));
  };
  return {
    completion: start(capability, onRows),
    cancel,
  };
}

/** Plan and consume an auto-run read without a proposal/run IPC race. */
export function runSqlReadStream(
  id: string,
  sql: string,
  onBatch: SqlStreamBatchHandler,
  origin?: string,
): SqlStreamController {
  return startSqlStream("", onBatch, (capability, onRows) =>
    invoke<SqlStreamReceipt>("run_sql_read_stream", {
      id,
      sql,
      origin: origin ?? null,
      capability,
      onRows,
    }));
}

async function pullAcceptAndAcknowledgeStreamBatch(
  ready: SqlStreamReady,
  onBatch: SqlStreamBatchHandler,
  isCancelled: () => boolean,
  cancel: () => Promise<void>,
  sendCancellation: () => Promise<unknown>,
): Promise<void> {
  try {
    if (isCancelled()) {
      await sendCancellation();
      return;
    }
    const batch = await invoke<SqlStreamBatch | null>("pull_sql_stream_batch", {
      operationId: ready.operationId,
      sequence: ready.sequence,
      capability: ready.capability,
    });
    if (!batch) throw new Error("stream batch is no longer available");
    if (isCancelled()) return;
    await onBatch(batch, {
      operationId: ready.operationId,
      capability: ready.capability,
      cancel: async () => {
        await cancel();
      },
    });
    if (isCancelled()) return;
  } catch {
    await sendCancellation();
    return;
  }
  const accepted = await invoke<boolean>("ack_sql_stream", {
    operationId: ready.operationId,
    sequence: ready.sequence,
    capability: ready.capability,
  }).catch(async () => {
    await sendCancellation();
    return false;
  });
  if (!accepted || isCancelled()) await sendCancellation();
}

// Plan and consume a SQL read without exposing an approval shortcut. Callers that may generate
// mutations must use the explicit proposal/approval/run sequence.
export async function runSqlRead(
  id: string,
  sql: string,
  origin?: string,
): Promise<ExecOutcome> {
  const proposal = await proposeSql(id, sql, origin);
  if (proposal.approvalRequired || proposal.classification.kind !== "read") {
    throw new Error("read execution helper rejected a target-mutating proposal");
  }
  return runSql(proposal.operationId);
}
