// Workspace-level observer for connection-scoped manual transactions. Individual
// query and data editors share the same TanStack Query keys, while this hook gives
// the status bar one recovery surface for transactions left outside the active view.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ConnectionProfile } from "../connections/domain";
import { qk } from "../../lib/queries";
import { usePostPaintReady } from "../../lib/usePostPaintReady";
import type { ManualTransactionStatus } from "./domain";
import {
  commitManualTransaction,
  listManualTransactions,
  rollbackManualTransaction,
} from "./tauriAdapter";

const ACTIVE_TRANSACTION_RECONCILIATION_MS = 30_000;

export type WorkspaceManualTransaction = ManualTransactionStatus & {
  connectionName: string;
};

export function useWorkspaceManualTransactions(
  connections: ConnectionProfile[],
) {
  const queryClient = useQueryClient();
  const postPaintReady = usePostPaintReady();
  const transactionConnections = useMemo(
    () =>
      connections.filter(
        (connection) =>
          connection.engine !== "mongodb" && connection.engine !== "bigquery",
      ),
    [connections],
  );
  const [settlingIds, setSettlingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const snapshot = useQuery({
    queryKey: qk.manualTransactions(),
    queryFn: listManualTransactions,
    enabled: postPaintReady,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      query.state.data?.length
      && globalThis.document?.visibilityState === "visible"
        ? ACTIVE_TRANSACTION_RECONCILIATION_MS
        : false,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (!snapshot.data) return;
    const statuses = new Map(
      snapshot.data.map((status) => [status.connectionId, status]),
    );
    for (const connection of transactionConnections) {
      queryClient.setQueryData(
        qk.manualTransaction(connection.id),
        statuses.get(connection.id) ?? null,
      );
    }
  }, [queryClient, snapshot.data, transactionConnections]);

  const connectionNames = new Map<string, string>(
    transactionConnections.map((connection) => [connection.id, connection.name]),
  );
  const transactions = (snapshot.data ?? []).flatMap((status) => {
    const connectionName = connectionNames.get(status.connectionId);
    return connectionName ? [{ ...status, connectionName }] : [];
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
      queryClient.setQueryData<ManualTransactionStatus[]>(
        qk.manualTransactions(),
        (current) =>
          current?.filter(
            (status) => status.connectionId !== transaction.connectionId,
          ),
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
