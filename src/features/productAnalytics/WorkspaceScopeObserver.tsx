import { useEffect } from "react";

import { useCatalogScope } from "../../lib/queries";
import {
  captureProductEventOncePerSession,
  useProductAnalyticsSnapshot,
} from "./client";
import { productAnalyticsWorkspaceContext } from "./outcomes";

/**
 * Records one privacy-bounded ready outcome for each usable workspace scope in
 * this app session. The capture client hashes raw identities before it retains
 * any de-duplication key, and StrictMode replays share one in-flight attempt.
 */
export function ProductAnalyticsWorkspaceScopeObserver() {
  const {
    accountScope,
    error,
    key,
    ready,
    workspaceId,
    workspaceKind,
  } = useCatalogScope();
  const analytics = useProductAnalyticsSnapshot();

  useEffect(() => {
    if (
      analytics.availability !== "available" ||
      analytics.consent !== "granted"
    ) {
      return;
    }
    const context = productAnalyticsWorkspaceContext({
      accountScope,
      error,
      key,
      ready,
      workspaceId,
      workspaceKind,
    });
    if (!context) return;
    void captureProductEventOncePerSession({
      name: "workspace_scope_ready",
      properties: { syncState: "ok" },
      context,
    });
  }, [
    analytics.availability,
    analytics.consent,
    accountScope,
    error,
    key,
    ready,
    workspaceId,
    workspaceKind,
  ]);

  return null;
}
