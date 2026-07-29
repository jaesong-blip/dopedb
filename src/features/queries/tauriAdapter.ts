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

export function inspectSql(
  id: string,
  sql: string,
  namespace?: string,
): Promise<SqlInspection> {
  return invoke("inspect_sql", {
    id,
    sql,
    namespace: namespace ?? null,
  });
}

export function proposeSql(
  id: string,
  sql: string,
  origin?: string,
  namespace?: string,
): Promise<SqlOperationProposal> {
  return invoke("propose_sql", {
    id,
    sql,
    namespace: namespace ?? null,
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
    invoke<SqlStreamReceipt>("run_sql_stream", {
      operationId,
      capability,
      onRows,
    }),
  );
}

function newStreamCapability(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
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
  let terminal: "open" | "cancelled" | "completed" | "error" = "open";
  let terminalError: Error | null = null;
  let firstBatchReceived = false;
  let readyQueue = Promise.resolve();
  const onRows = new Channel<SqlStreamReady>();
  const sendCancellation = (knownOperationId = activeOperationId) =>
    invoke("cancel_sql_stream", {
      operationId: knownOperationId || null,
      capability,
    });
  const bestEffortCancel = async (knownOperationId = activeOperationId) => {
    await Promise.resolve(sendCancellation(knownOperationId)).catch(
      () => undefined,
    );
  };
  const cancel = async () => {
    if (terminal !== "open") return;
    terminal = "cancelled";
    await bestEffortCancel();
  };
  const fail = async (error: unknown) => {
    if (terminal !== "open") return;
    terminal = "error";
    terminalError =
      error instanceof Error ? error : new Error("SQL stream transport failed");
    await bestEffortCancel();
  };
  onRows.onmessage = (ready) => {
    // A late ready never becomes a late pull/ACK. When auto-read cancellation
    // learned its operation only after planning, send the exact cancellation.
    if (terminal !== "open") {
      void bestEffortCancel(ready.operationId);
      return;
    }
    if (
      ready.capability !== capability ||
      (activeOperationId !== "" && ready.operationId !== activeOperationId)
    ) {
      void fail(new Error("stream ready notification did not match its owner"));
      return;
    }
    activeOperationId = ready.operationId;
    // Keep the serialized queue usable after failures; a cancellation transport
    // rejection must not poison later cleanup or make completion hang.
    readyQueue = readyQueue
      .then(() =>
        pullAcceptAndAcknowledgeStreamBatch(
          ready,
          onBatch,
          () => terminal === "open",
          cancel,
          fail,
          bestEffortCancel,
          () => {
            if (firstBatchReceived) return;
            firstBatchReceived = true;
            globalThis.performance?.mark?.(
              "desktop_query_stream_first_batch_received",
            );
          },
        ),
      )
      .catch(() => undefined);
  };
  let startPromise: Promise<SqlStreamReceipt>;
  try {
    startPromise = start(capability, onRows);
  } catch (error) {
    startPromise = Promise.reject(error);
  }
  return {
    completion: startPromise
      .then(async (receipt) => {
        // The backend only completes after its last credit, but awaiting this
        // exact queue makes the frontend contract explicit and testable.
        await readyQueue;
        if (terminal === "error") throw terminalError;
        if (
          activeOperationId !== "" &&
          receipt.operationId !== activeOperationId
        ) {
          terminal = "error";
          terminalError = new Error(
            "stream completion did not match the owning operation",
          );
          await bestEffortCancel();
          throw new Error(
            "stream completion did not match the owning operation",
          );
        }
        if (terminal === "open") terminal = "completed";
        return receipt;
      })
      .catch(async (error) => {
        if (terminal === "open") await fail(error);
        throw error;
      })
      .finally(() => {
        // Keep the handler alive while the start command is pending: a
        // cancellation may learn its exact operation only from a late ready.
        onRows.onmessage = () => undefined;
      }),
    cancel,
  };
}

/** Plan and consume an auto-run read without a proposal/run IPC race. */
export function runSqlReadStream(
  id: string,
  sql: string,
  onBatch: SqlStreamBatchHandler,
  origin?: string,
  namespace?: string,
): SqlStreamController {
  return startSqlStream("", onBatch, (capability, onRows) =>
    invoke<SqlStreamReceipt>("run_sql_read_stream", {
      id,
      sql,
      namespace: namespace ?? null,
      origin: origin ?? null,
      capability,
      onRows,
    }),
  );
}

async function pullAcceptAndAcknowledgeStreamBatch(
  ready: SqlStreamReady,
  onBatch: SqlStreamBatchHandler,
  isOpen: () => boolean,
  cancel: () => Promise<void>,
  fail: (error: unknown) => Promise<void>,
  bestEffortCancel: () => Promise<void>,
  markFirstBatchReceived: () => void,
): Promise<void> {
  try {
    if (!isOpen()) {
      await bestEffortCancel();
      return;
    }
    const batch = await invoke<SqlStreamBatch | null>("pull_sql_stream_batch", {
      operationId: ready.operationId,
      sequence: ready.sequence,
      capability: ready.capability,
    });
    if (!batch) throw new Error("stream batch is no longer available");
    if (
      batch.operationId !== ready.operationId ||
      batch.sequence !== ready.sequence
    ) {
      throw new Error("stream batch did not match its ready notification");
    }
    if (!isOpen()) return;
    markFirstBatchReceived();
    await onBatch(batch, {
      operationId: ready.operationId,
      capability: ready.capability,
      cancel: async () => {
        await cancel();
      },
    });
    if (!isOpen()) return;
  } catch (error) {
    await fail(error);
    return;
  }
  if (!isOpen()) return;
  try {
    const accepted = await invoke<boolean>("ack_sql_stream", {
      operationId: ready.operationId,
      sequence: ready.sequence,
      capability: ready.capability,
    });
    if (!accepted) throw new Error("stream batch acknowledgement was rejected");
  } catch (error) {
    await fail(error);
  }
}

// Plan and consume a SQL read without exposing an approval shortcut. Callers that may generate
// mutations must use the explicit proposal/approval/run sequence.
/** Bounded legacy page read used only by paginated table data, never SQL console output. */
export async function runSqlBoundedPage(
  id: string,
  sql: string,
  origin?: string,
): Promise<ExecOutcome> {
  const proposal = await proposeSql(id, sql, origin);
  if (proposal.approvalRequired || proposal.classification.kind !== "read") {
    throw new Error(
      "read execution helper rejected a target-mutating proposal",
    );
  }
  return runSql(proposal.operationId);
}
