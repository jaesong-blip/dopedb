import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import type { Dashboard } from "../dashboards/domain";
import type { WorkbenchDocument } from "../workbench/domain";
import type { AppArea } from "./WorkbenchRail";

export function preloadSqlEditor() {
  void import("../../components/SqlViewer").catch(() => undefined);
}

export function useSqlEditorPreload(
  selectedConnectionId: string | null,
  supportsSql: boolean,
) {
  useEffect(() => {
    if (!selectedConnectionId || !supportsSql) return;
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preloadSqlEditor, { timeout: 1_500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(preloadSqlEditor, 300);
    return () => window.clearTimeout(id);
  }, [selectedConnectionId, supportsSql]);
}

export function usePersistentAppArea() {
  const [area, setArea] = useState<AppArea>(() =>
    localStorage.getItem("appArea") === "dashboard" ||
    localStorage.getItem("tab") === "dashboard"
      ? "dashboard"
      : "workspace",
  );
  useEffect(() => {
    localStorage.setItem("appArea", area);
    localStorage.setItem("tab", area === "dashboard" ? "dashboard" : "data");
  }, [area]);
  return [area, setArea] as const;
}

export function usePersistentSelectedConnection() {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    localStorage.getItem("selectedId"),
  );
  useEffect(() => {
    if (selectedId) localStorage.setItem("selectedId", selectedId);
    else localStorage.removeItem("selectedId");
  }, [selectedId]);
  return [selectedId, setSelectedId] as const;
}

export function useRestoredWorkbenchState() {
  const legacyAuditOpen = useRef(localStorage.getItem("tab") === "audit");
  const restoredDocumentKind = useRef<WorkbenchDocument["kind"]>(
    (() => {
      const saved = localStorage.getItem("tab");
      if (saved === "history" || saved === "audit") return "activity";
      if (
        saved === "sql" ||
        saved === "documents" ||
        saved === "schema" ||
        saved === "welcome"
      ) {
        return saved;
      }
      return "welcome";
    })(),
  ).current;
  return { legacyAuditOpen, restoredDocumentKind };
}

export function useDashboardCreation(onCreated: (dashboard: Dashboard) => void) {
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    const pending = listen<Dashboard>("dashboard:created", (event) => {
      setFocusId(event.payload.id);
      onCreated(event.payload);
    }).catch((error) => console.error("dashboard event listen failed:", error));
    return () => {
      void pending.then((unlisten) => unlisten && unlisten());
    };
  }, [onCreated]);
  return {
    focusId,
    setFocusId,
    consumeFocus: useCallback(() => setFocusId(null), []),
  };
}

export function useActivitySeen(
  activeKind: WorkbenchDocument["kind"] | null,
  unseen: number,
  markSeen: () => void,
) {
  useEffect(() => {
    if (activeKind === "activity" && unseen > 0) markSeen();
  }, [activeKind, markSeen, unseen]);
}
