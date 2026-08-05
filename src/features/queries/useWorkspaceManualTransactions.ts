// Workspace-level observer for connection-scoped manual transactions. Individual
// query and data editors share the same TanStack Query keys, while this hook gives
// the status bar one recovery surface for transactions left outside the active view.
import { useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";

import type { ConnectionProfile } from "../connections/domain";
import { qk } from "../../lib/queries";
import type { ManualTransactionStatus } from "./domain";
import {
  commitManualTransaction,
  getManualTransaction,
  rollbackManualTransaction,
} from "./tauriAdapter";

export type WorkspaceManualTransaction = ManualTransactionStatus & {
  connectionName: string;
};

export function useWorkspaceManualTransactions(
  connections: ConnectionProfile[],
) {
  const queryClient = useQueryClient();
  const transactionConnections = connections.filter(
    (connection) => connection.engine !== "mongodb",
  );
  const [settlingIds, setSettlingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const queries = useQueries({
    queries: transactionConnections.map((connection) => ({
      queryKey: qk.manualTransaction(connection.id),
      queryFn: () => getManualTransaction(connection.id),
      refetchInterval: 2_000,
    })),
  });
  const transactions = queries.flatMap((query, index) => {
    const status = query.data;
    const connection = transactionConnections[index];
    return status && connection
      ? [{ ...status, connectionName: connection.name }]
      : [];
  });

  async function settle(
    transaction: WorkspaceManualTransaction,
    action: "commit" | "rollback",
  ) {
    if (settlingIds.has(transaction.transactionId)) return;
    setSettlingIds((current) => {
      const next = new Set(current);
      next.add(transaction.transactionId);
      return next;
    });
    try {
      if (action === "commit") {
        await commitManualTransaction(
          transaction.connectionId,
          transaction.transactionId,
        );
      } else {
        await rollbackManualTransaction(
          transaction.connectionId,
          transaction.transactionId,
        );
      }
      queryClient.setQueryData(
        qk.manualTransaction(transaction.connectionId),
        null,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["tableRows", transaction.connectionId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["tableCount", transaction.connectionId],
        }),
        queryClient.invalidateQueries({
          queryKey: qk.history(transaction.connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: qk.audit(transaction.connectionId),
        }),
      ]);
    } finally {
      setSettlingIds((current) => {
        const next = new Set(current);
        next.delete(transaction.transactionId);
        return next;
      });
    }
  }

  return {
    transactions,
    settlingIds,
    commit: (transaction: WorkspaceManualTransaction) =>
      settle(transaction, "commit"),
    rollback: (transaction: WorkspaceManualTransaction) =>
      settle(transaction, "rollback"),
  };
}
