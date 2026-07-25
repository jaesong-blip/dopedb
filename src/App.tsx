// Desktop workbench shell: coordinates the selected connection, document surface,
// workspace navigation, and the persistent connection-pinned Terminal Dock.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useQuery } from "@tanstack/react-query";
import { getSafety } from "./ipc/commands";
import type {
  CatalogTable,
  Dashboard,
  SafetySettings,
} from "./ipc/types";
import { errMessage } from "./ipc/types";
import type { ConnectionProfile } from "./features/connections/domain";
import { listConnections } from "./features/connections/tauriAdapter";
import type { SqlDocument } from "./features/sqlDocuments/domain";
import { tauriSqlDocumentGateway } from "./features/sqlDocuments/tauriAdapter";
import {
  queryDocument,
  stableDocument,
  tableDocument,
  type WorkbenchDocument,
} from "./features/workbench/domain";
import { useWorkbenchDocuments } from "./features/workbench/useWorkbenchDocuments";
import AgentLogDialog from "./components/AgentLogDialog";
import EngineMark from "./components/EngineMark";
import { Icon } from "./components/Icon";
import TerminalDock from "./components/TerminalDock/TerminalDock";
import WorkbenchDocumentStrip from "./components/WorkbenchDocumentStrip";
import { ToastProvider, useToast } from "./components/Toast";
import WorkspaceAccount from "./features/workspaces/components/WorkspaceAccount";
import WorkspaceSwitcher from "./features/workspaces/components/WorkspaceSwitcher";
import { hasCapability, isDocumentEngine } from "./lib/capabilities";
import { useI18n, type I18nKey } from "./lib/i18n";
import {
  OperationActivityProvider,
  useOperationActivity,
} from "./lib/operationActivity";
import {
  driversQuery,
  isTransientDbError,
  skillStatusQuery,
} from "./lib/queries";
import { buildConnectionSections, type SchemaConnectionGroup } from "./lib/schemaDiff";
import { tableKey, tableLabel } from "./lib/tableRef";
import Activity from "./screens/Activity";
import { ConnectionForm, DatabaseExplorer } from "./screens/Connections";
import Dashboards, { DashboardSidebar } from "./screens/Dashboards";
import Documents from "./screens/Documents";
import Onboarding from "./screens/Onboarding";
import SchemaExplorer from "./screens/Schema";
import SchemaDiff from "./screens/SchemaDiff";
import Settings from "./screens/Settings";
import type { SettingsSection } from "./screens/Settings";
import Sql from "./screens/Sql";
import TableData from "./screens/Tables";

// Chat2DB-style information architecture:
// - the global rail switches products (database workspace / dashboard);
// - database tools are real documents inside the selected connection's workbench;
// - interactive Shell/Agent sessions live in a persistent, connection-pinned Terminal Dock.
type AppArea = "workspace" | "dashboard";

// `null` = not editing; "new" = blank form; a profile = edit that profile.
type Editing = ConnectionProfile | "new" | null;

export default function App() {
  return (
    <ToastProvider>
      <OperationActivityProvider>
        <Shell />
      </OperationActivityProvider>
    </ToastProvider>
  );
}

const SIDEBAR_MIN = 180;
const IS_MACOS = typeof navigator !== "undefined"
  && /Macintosh|Mac OS X/.test(navigator.userAgent);
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 240;
const TERMINAL_DOCK_MIN = 360;
const TERMINAL_DOCK_MAX = 720;
const TERMINAL_DOCK_DEFAULT = 480;
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function preloadSqlEditor() {
  void import("./components/SqlViewer").catch(() => undefined);
}

function connectionEndpoint(conn: ConnectionProfile) {
  if (conn.engine === "sqlite") return conn.database || conn.host || "sqlite";
  return `${conn.host}${conn.port ? `:${conn.port}` : ""}`;
}

function ConnectionPicker({
  connections,
  onSelect,
  onNew,
}: {
  connections: ConnectionProfile[];
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const { t } = useI18n();
  const sections = useMemo(() => buildConnectionSections(connections), [connections]);
  const grouped = sections.filter((section) => section.kind === "group");
  const singles = sections.filter((section) => section.kind === "single");

  function renderConnectionCard(conn: ConnectionProfile, grouped = false) {
    const name = conn.name || t("app.unnamed");
    return (
      <button
        key={conn.id}
        type="button"
        className="connection-card"
        onClick={() => onSelect(conn.id)}
        title={`${conn.engine} · ${connectionEndpoint(conn)} · ${conn.database}`}
        aria-label={t("app.openConnection", { name })}
      >
        <span className="connection-card-title">
          {!grouped && <EngineMark engine={conn.engine} />}
          <span className="connection-card-name">{name}</span>
          {conn.env && <span className={`env-chip env-${conn.env}`}>{conn.env}</span>}
        </span>
        <span className="connection-card-meta">
          <span>{conn.database || t("common.unknown")}</span>
          <span className="ds-meta-dot" />
          <span>{connectionEndpoint(conn)}</span>
        </span>
      </button>
    );
  }

  function renderGroup(group: SchemaConnectionGroup) {
    const engine = group.connections[0]?.engine;
    return (
      <section className="connection-group-section" key={group.key}>
        <div className="connection-group-head">
          <div className="connection-group-title">
            {engine ? <EngineMark engine={engine} /> : <span className="connection-group-mark" />}
            <span>{group.label}</span>
          </div>
        </div>
        <div className="connection-card-grid">
          {group.connections.map((conn) => renderConnectionCard(conn, true))}
        </div>
      </section>
    );
  }

  return (
    <div className="connection-picker">
      <div className="connection-picker-head">
        <h2>{t("app.connectionPickerTitle")}</h2>
        <button className="btn small" onClick={onNew}>
          <Icon name="plus" />
          {t("connections.new")}
        </button>
      </div>

      {grouped.length > 0 && (
        <section className="connection-picker-section">
          <div className="connection-picker-label">{t("app.connectionPickerGroups")}</div>
          {grouped.map((section) =>
            section.kind === "group" ? renderGroup(section.group) : null,
          )}
        </section>
      )}

      {singles.length > 0 && (
        <section className="connection-picker-section">
          <div className="connection-picker-label">{t("app.connectionPickerSingles")}</div>
          <div className="connection-card-grid">
            {singles.map((section) =>
              section.kind === "single" ? renderConnectionCard(section.connection) : null,
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// Product-level rail. Data/ER/query/history are intentionally absent: those actions
// live in the workbench document bar, so there is only one path to each tool.
function WorkbenchRail({
  area,
  dashboardAvailable,
  settingsOpen,
  sidebarExpanded,
  account,
  onArea,
  onSettings,
}: {
  area: AppArea | null;
  dashboardAvailable: boolean;
  settingsOpen: boolean;
  sidebarExpanded: boolean;
  account: ReactNode;
  onArea: (area: AppArea) => void;
  onSettings: () => void;
}) {
  const { t } = useI18n();
  const items: Array<{
    id: AppArea;
    icon: "database" | "dashboard";
    label: I18nKey;
  }> = [
    { id: "workspace", icon: "database", label: "workspace.label" },
    { id: "dashboard", icon: "dashboard", label: "tabs.dashboard" },
  ];
  return (
    <nav
      className="workbench-rail"
      aria-label={t("app.workbenchNavigation")}
      onKeyDown={(event) => {
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
          return;
        }
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ".workbench-rail-button:not(:disabled), [data-rail-control]:not(:disabled)",
          ),
        ];
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        if (current < 0) return;
        event.preventDefault();
        const direction =
          event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
        buttons[(current + direction + buttons.length) % buttons.length]?.focus();
      }}
    >
      {/* Overlay title bars place native traffic lights above the webview. This
          structural slot reserves that OS-owned rectangle before any app control. */}
      <div
        className="workbench-window-controls-safe"
        data-window-controls-safe-zone
        data-tauri-drag-region="deep"
        aria-hidden="true"
      />
      <div className="workbench-rail-brand">d</div>
      <div className="workbench-rail-items">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`workbench-rail-button${area === item.id ? " active" : ""}`}
            onClick={() => onArea(item.id)}
            title={t(item.label)}
            aria-label={t(item.label)}
            aria-current={area === item.id ? "page" : undefined}
            aria-controls="workbench-sidebar"
            aria-expanded={area === item.id ? sidebarExpanded : undefined}
            disabled={item.id === "dashboard" && !dashboardAvailable}
          >
            <Icon name={item.icon} />
          </button>
        ))}
      </div>
      <div className="workbench-rail-bottom">
        {account}
        <button
          type="button"
          className={`workbench-rail-button${settingsOpen ? " active" : ""}`}
          onClick={onSettings}
          title={t("common.settings")}
          aria-label={t("common.settings")}
          aria-current={settingsOpen ? "page" : undefined}
        >
          <Icon name="gear" />
        </button>
      </div>
    </nav>
  );
}

function Shell() {
  const { t } = useI18n();
  const { unseen, latest, markSeen } = useOperationActivity();
  const toast = useToast();
  // Keep one bounded Skill inventory observer alive for the app lifecycle. This performs
  // the required startup scan and rechecks after focus without creating install roots.
  const skillStatusQ = useQuery(skillStatusQuery());
  const [conns, setConns] = useState<ConnectionProfile[]>([]);
  // Resizable sidebar: drag the divider, double-click resets; width persists.
  const [sidebarW, setSidebarW] = useState(() => {
    const w = Number(localStorage.getItem("sidebarW"));
    return w >= SIDEBAR_MIN && w <= SIDEBAR_MAX ? w : SIDEBAR_DEFAULT;
  });
  const startSidebarDrag = (e: { preventDefault(): void; clientX: number }) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    const clamp = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
    const move = (ev: MouseEvent) => setSidebarW(clamp(startW + ev.clientX - startX));
    const up = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      localStorage.setItem("sidebarW", String(clamp(startW + ev.clientX - startX)));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    localStorage.getItem("selectedId"),
  );
  const [editing, setEditing] = useState<Editing>(null);
  const [safety, setSafety] = useState<SafetySettings | null>(null);
  const [safetyError, setSafetyError] = useState<string | null>(null);
  // A user who last had the old Audit tab open should land in its expanded details
  // after the two top-level tabs are consolidated into Activity.
  const legacyAuditOpen = useRef(localStorage.getItem("tab") === "audit");
  const restoredDocumentKind = useRef<WorkbenchDocument["kind"]>(
    (() => {
      const saved = localStorage.getItem("tab");
      if (saved === "history" || saved === "audit") return "activity";
      if (saved === "sql" || saved === "documents" || saved === "schema") return saved;
      return "schema";
    })(),
  ).current;
  const [area, setArea] = useState<AppArea>(() =>
    localStorage.getItem("appArea") === "dashboard" || localStorage.getItem("tab") === "dashboard"
      ? "dashboard"
      : "workspace",
  );
  const [terminalDockOpen, setTerminalDockOpen] = useState(() => {
    const saved = localStorage.getItem("terminalDockOpen");
    if (saved !== null) return saved !== "0";
    return localStorage.getItem("agentDockOpen") !== "0";
  });
  const [terminalDockWidth, setTerminalDockWidth] = useState(() => {
    const saved = Number(localStorage.getItem("terminalDockWidth"));
    return saved >= TERMINAL_DOCK_MIN && saved <= TERMINAL_DOCK_MAX
      ? saved
      : TERMINAL_DOCK_DEFAULT;
  });
  const [terminalOverlay, setTerminalOverlay] = useState(
    () => window.matchMedia("(max-width: 900px)").matches,
  );
  const [compactShell, setCompactShell] = useState(
    () => window.matchMedia("(max-width: 560px)").matches,
  );
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  const mainRef = useRef<HTMLElement | null>(null);
  const dismissMobileExplorer = useCallback((restoreRailFocus = false) => {
    setMobileExplorerOpen(false);
    if (restoreRailFocus) {
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            '.workbench-rail-button[aria-current="page"]',
          )
          ?.focus();
      });
    }
  }, []);
  const focusMainAfterMobileSelection = useCallback(() => {
    if (!window.matchMedia("(max-width: 560px)").matches) return;
    window.requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
  }, []);
  const [dashboardFocusId, setDashboardFocusId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    SettingsSection | undefined
  >(undefined);
  const [schemaDiffGroupKey, setSchemaDiffGroupKey] = useState<string | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [agentLogOpen, setAgentLogOpen] = useState(false);
  const terminalButtonRef = useRef<HTMLButtonElement | null>(null);
  const updateCheckInFlight = useRef(false);
  const lastUpdateCheckAt = useRef(0);
  const openDashboard = useCallback((dashboard: Dashboard) => {
    setSelectedId(dashboard.connectionId);
    setEditing(null);
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    setDashboardFocusId(dashboard.id);
    setArea("dashboard");
  }, []);
  const consumeDashboardFocus = useCallback(() => setDashboardFocusId(null), []);

  // Terminal CLI creation emits the saved Dashboard payload so the library can
  // focus it immediately without accepting SQL or connection replacements in UI IPC.
  useEffect(() => {
    const pending = listen<Dashboard>("dashboard:created", (event) => {
      openDashboard(event.payload);
    }).catch((error) => console.error("dashboard event listen failed:", error));
    return () => {
      void pending.then((unlisten) => unlisten && unlisten());
    };
  }, [openDashboard]);

  // Persist the product area and selected connection. Keep writing the legacy `tab`
  // key for one release so older builds can still restore a sensible destination.
  useEffect(() => {
    localStorage.setItem("appArea", area);
    localStorage.setItem("tab", area === "dashboard" ? "dashboard" : "data");
  }, [area]);
  useEffect(() => {
    if (selectedId) localStorage.setItem("selectedId", selectedId);
    else localStorage.removeItem("selectedId");
  }, [selectedId]);

  const selected = conns.find((c) => c.id === selectedId) ?? null;
  const showTerminalDock =
    terminalDockOpen && !!selected && !settingsOpen && editing === null;
  // Schema diff is a SQL-only comparison feature — a group whose connections are MongoDB
  // is never a valid diff candidate, even if one somehow carries a schemaGroup value.
  const schemaGroups = useMemo(
    () =>
      buildConnectionSections(conns).flatMap((section) =>
        section.kind === "group" && !isDocumentEngine(section.group.connections[0]?.engine)
          ? [section.group]
          : [],
      ),
    [conns],
  );
  const activeSchemaGroup =
    schemaGroups.find((group) => group.key === schemaDiffGroupKey) ?? null;

  // SQL and Documents are mutually exclusive per connection, gated by the resolved
  // driver capability. Engine fallback avoids a SQL/Documents flash while drivers load.
  const driversQ = useQuery(driversQuery());
  const supportsSql =
    !selected ||
    (driversQ.data
      ? hasCapability(driversQ.data, selected, "sql")
      : !isDocumentEngine(selected.engine));
  const workbench = useWorkbenchDocuments({
    selectedConnectionId: selected?.id ?? null,
    supportsSql,
    restoredDocumentKind,
    sqlDocuments: tauriSqlDocumentGateway,
    onRestoreError: (error) => {
      console.error("could not restore SQL documents:", error);
    },
  });
  const {
    selectedDocuments,
    activeDocument,
    activeDocumentId,
  } = workbench;
  const selectedTable = activeDocument?.kind === "data" ? activeDocument.table : null;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const sync = () => setTerminalOverlay(media.matches);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 560px)");
    const sync = () => {
      setCompactShell(media.matches);
      if (!media.matches) setMobileExplorerOpen(false);
    };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!mobileExplorerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissMobileExplorer(true);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [dismissMobileExplorer, mobileExplorerOpen]);

  // CodeMirror is intentionally split out of the startup bundle. Warm that chunk only
  // after a SQL-capable connection exists, using idle time so the first SQL click does
  // not also pay module download/parse cost.
  useEffect(() => {
    if (!selected || !supportsSql) return;
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preloadSqlEditor, { timeout: 1_500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(preloadSqlEditor, 300);
    return () => window.clearTimeout(id);
  }, [selected?.id, supportsSql]);

  useEffect(() => {
    if (schemaDiffGroupKey && !activeSchemaGroup) setSchemaDiffGroupKey(null);
  }, [activeSchemaGroup, schemaDiffGroupKey]);

  // Transient (network-shaped) load failures retry themselves with backoff instead of
  // parking on the error card until the user clicks retry; deterministic failures still
  // surface immediately. Manual retry re-enters at attempt 0.
  function refresh(attempt = 0): Promise<ConnectionProfile[]> {
    return listConnections()
      .then((cs) => {
        setConns(cs);
        setLoadError(null);
        return cs;
      })
      .catch((e) => {
        if (attempt < 3 && isTransientDbError(e)) {
          return new Promise<void>((resolve) =>
            window.setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8_000)),
          ).then(() => refresh(attempt + 1));
        }
        setLoadError(errMessage(e));
        return [];
      });
  }

  async function reloadWorkspaceScope() {
    setSelectedId(null);
    workbench.reset();
    setEditing(null);
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    setDashboardFocusId(null);
    setSafety(null);
    setConns([]);
    await refresh();
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function refreshAvailableUpdate() {
    if (updateCheckInFlight.current) return;
    updateCheckInFlight.current = true;
    try {
      const next = await check();
      lastUpdateCheckAt.current = Date.now();
      setAvailableUpdate(next);
    } catch {
      lastUpdateCheckAt.current = Date.now();
    } finally {
      updateCheckInFlight.current = false;
    }
  }

  useEffect(() => {
    void refreshAvailableUpdate();
    const iv = window.setInterval(() => void refreshAvailableUpdate(), UPDATE_CHECK_INTERVAL_MS);
    const onVisibility = () => {
      if (document.hidden) return;
      if (Date.now() - lastUpdateCheckAt.current >= UPDATE_CHECK_INTERVAL_MS) {
        void refreshAvailableUpdate();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Nudge (not hijack) when a Terminal operation finishes while the dock is hidden.
  // Skip the mount baseline and throttle bursts to one toast per 30 seconds.
  const seenOperationId = useRef<number | null>(null);
  const surfaceInit = useRef(true);
  const lastToastAt = useRef(0);
  useEffect(() => {
    if (surfaceInit.current) {
      surfaceInit.current = false;
      seenOperationId.current = latest?.id ?? null;
      return;
    }
    if (latest && latest.id !== seenOperationId.current) {
      seenOperationId.current = latest.id;
      const now = Date.now();
      if (!showTerminalDock && now - lastToastAt.current > 30000) {
        lastToastAt.current = now;
        toast(t("app.toastAgentQuery"));
      }
    }
  }, [latest, showTerminalDock, toast]);

  // Operation activity is considered seen only after the user explicitly opens the
  // secondary log surface.
  useEffect(() => {
    if (agentLogOpen && unseen > 0) markSeen();
  }, [agentLogOpen, unseen, markSeen]);

  // Per-connection safety drives the Data/SQL views (max rows, auto-run reads).
  // safetyReqId guards against out-of-order resolution: getSafety runs on a pooled
  // SqlitePool so a fast A→B connection switch can resolve A last — only apply a
  // response if its id is still the latest requested one.
  const safetyReqId = useRef<string | null>(null);
  function loadSafety(id: string) {
    safetyReqId.current = id;
    setSafety(null);
    setSafetyError(null);
    getSafety(id)
      .then((s) => {
        if (safetyReqId.current === id) setSafety(s);
      })
      .catch((e) => {
        if (safetyReqId.current === id) setSafetyError(errMessage(e));
      });
  }

  useEffect(() => {
    if (selectedId) loadSafety(selectedId);
    else {
      safetyReqId.current = null;
      setSafety(null);
    }
  }, [selectedId]);

  const refreshSafety = () => {
    if (selectedId) loadSafety(selectedId);
  };

  async function loadSql(sql: string) {
    if (!selected) return;
    let document: WorkbenchDocument;
    try {
      document = await workbench.openQuery({
        connectionId: selected.id,
        supportsSql,
        title: "History query",
        content: sql,
      });
    } catch (error) {
      toast(errMessage(error), "error");
      return;
    }
    workbench.activate(document);
    setArea("workspace");
  }

  function openAgentToolsSettings() {
    setSettingsSection("agent-tools");
    setSettingsOpen(true);
    setSchemaDiffGroupKey(null);
    setEditing(null);
  }

  function openUpdateSettings() {
    setSettingsSection("updates");
    setSettingsOpen(true);
    setSchemaDiffGroupKey(null);
    setEditing(null);
  }

  const openTerminalDock = useCallback(() => {
    localStorage.setItem("terminalDockOpen", "1");
    setTerminalDockOpen(true);
  }, []);

  const closeTerminalDock = useCallback(() => {
    localStorage.setItem("terminalDockOpen", "0");
    setTerminalDockOpen(false);
    window.requestAnimationFrame(() => terminalButtonRef.current?.focus());
  }, []);

  const updateTerminalDockWidth = useCallback((next: number) => {
    const width = Math.min(
      TERMINAL_DOCK_MAX,
      Math.max(TERMINAL_DOCK_MIN, Math.round(next)),
    );
    setTerminalDockWidth(width);
    localStorage.setItem("terminalDockWidth", String(width));
  }, []);

  function toggleTerminalDock() {
    if (!selected) return;
    if (showTerminalDock) {
      closeTerminalDock();
      return;
    }
    setSettingsOpen(false);
    setEditing(null);
    setSchemaDiffGroupKey(null);
    setMobileExplorerOpen(false);
    openTerminalDock();
  }

  function syncAvailableUpdate(update: Update | null) {
    lastUpdateCheckAt.current = Date.now();
    setAvailableUpdate(update);
  }

  function selectConnection(id: string, nextArea: AppArea = area) {
    const connection = conns.find((candidate) => candidate.id === id);
    const initial = connection && isDocumentEngine(connection.engine)
      ? queryDocument(id, "documents")
      : stableDocument(id, "schema");
    workbench.prime(initial);
    setSelectedId(id);
    setEditing(null);
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    setDashboardFocusId(null);
    setAgentLogOpen(false);
    setMobileExplorerOpen(false);
    setArea(nextArea);
    focusMainAfterMobileSelection();
  }

  function activateDocument(
    document: WorkbenchDocument,
    closeMobileExplorer = true,
  ) {
    workbench.activate(document);
    setEditing(null);
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    if (closeMobileExplorer) {
      setMobileExplorerOpen(false);
      if (mobileExplorerOpen) focusMainAfterMobileSelection();
    }
    setArea("workspace");
  }

  function openTableDocument(connection: ConnectionProfile, table: CatalogTable) {
    const document = tableDocument(connection.id, table);
    if (selectedId !== connection.id) {
      workbench.prime(document);
      setSelectedId(connection.id);
    }
    activateDocument(document);
  }

  function openStableDocument(
    kind: "schema" | "activity",
    closeMobileExplorer = true,
  ) {
    if (!selected) return;
    activateDocument(stableDocument(selected.id, kind), closeMobileExplorer);
  }

  async function openQueryDocument() {
    if (!selected) return;
    preloadSqlEditor();
    try {
      const document = await workbench.openQuery({
        connectionId: selected.id,
        supportsSql,
      });
      activateDocument(document);
    } catch (error) {
      toast(errMessage(error), "error");
    }
  }

  function closeDocument(id: string) {
    if (!selected) return;
    workbench.close(id, selected.id, supportsSql);
  }

  function setActiveQueryDraft(value: string) {
    if (!activeDocument || (activeDocument.kind !== "sql" && activeDocument.kind !== "documents")) {
      return;
    }
    workbench.updateDraft(activeDocument.id, value);
  }

  function setActiveQueryTitle(value: string) {
    if (!activeDocument || activeDocument.kind !== "sql") return;
    workbench.updateTitle(activeDocument.id, value);
  }

  function applySavedQuery(saved: SqlDocument) {
    if (!activeDocument || activeDocument.kind !== "sql") return;
    workbench.applyPersisted(activeDocument.id, saved);
  }

  function startNewConnection() {
    setEditing("new");
    setSettingsOpen(false);
    setSchemaDiffGroupKey(null);
    setMobileExplorerOpen(false);
    focusMainAfterMobileSelection();
  }

  function renderMain() {
    if (settingsOpen) {
      return (
        <Settings
          connection={selected}
          initialSection={settingsSection}
          refreshSafety={refreshSafety}
          availableUpdate={availableUpdate}
          onUpdateChecked={syncAvailableUpdate}
          onClose={() => setSettingsOpen(false)}
        />
      );
    }
    if (activeSchemaGroup) {
      return (
        <SchemaDiff
          key={activeSchemaGroup.key}
          group={activeSchemaGroup}
          onClose={() => setSchemaDiffGroupKey(null)}
        />
      );
    }
    if (editing !== null) {
      return (
        <div className="editor-pane">
          <ConnectionForm
            initial={editing === "new" ? null : editing}
            onSaved={async (p) => {
              await refresh();
              setSelectedId(p.id);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      );
    }
    // Startup failure takes precedence over onboarding: a store read error must not
    // look like "no connections yet" to a user who has 10 saved.
    if (loadError) {
      return (
        <div className="placeholder">
          <div className="error">
            {t("app.couldNotLoadConnections", { error: loadError })}
          </div>
          <button className="btn" onClick={() => void refresh()}>
            {t("app.retry")}
          </button>
        </div>
      );
    }
    if (conns.length === 0) {
      return (
        <Onboarding
          onNewConnection={() => setEditing("new")}
          onOpenAgentTools={openAgentToolsSettings}
        />
      );
    }
    const safetyFallback = safetyError ? (
      <div className="error">
        {t("app.loadSafetyFailed", { error: safetyError })}{" "}
        <button className="btn small" onClick={() => selectedId && loadSafety(selectedId)}>
          {t("app.retry")}
        </button>
      </div>
    ) : (
      <div className="muted">{t("app.loading")}</div>
    );

    // Every workbench view needs the global connection context. With no connection selected,
    // the rail stays reachable but the current view asks for one explicit selection.
    const needsConn = (
      <ConnectionPicker
        connections={conns}
        onSelect={(id) => selectConnection(id, area)}
        onNew={startNewConnection}
      />
    );

    return (
      <>
        {selected && (
          <header className="main-head ds-workbench-head" data-tauri-drag-region="deep">
            <div className="ds-workbench-title">
              <div className="ds-title-line app-title-line">
                <EngineMark engine={selected.engine} />
                <strong>{selected.name || t("app.unnamed")}</strong>
                {selected.env && <span className={`env-chip env-${selected.env}`}>{selected.env}</span>}
                <span className="ds-meta-dot" />
                <span className="app-title-meta">{selected.database}</span>
                {area === "workspace" && selectedTable && (
                  <>
                    <span className="ds-meta-dot" />
                    <span className="app-title-meta">{tableLabel(selected.engine, selectedTable)}</span>
                  </>
                )}
              </div>
            </div>
            <div className="main-head-actions ds-control-row">
              <button
                ref={terminalButtonRef}
                type="button"
                className={`btn small icon-only main-terminal-toggle${showTerminalDock ? " active" : ""}`}
                onClick={toggleTerminalDock}
                title={t("terminal.title")}
                aria-label={t("terminal.title")}
                aria-pressed={showTerminalDock}
              >
                <Icon name="terminal" />
                {unseen > 0 && (
                  <span className="workbench-rail-count">
                    {unseen > 9 ? "9+" : unseen}
                  </span>
                )}
              </button>
            </div>
          </header>
        )}

        {selected && area === "workspace" && (
          <WorkbenchDocumentStrip
            documents={selectedDocuments}
            activeId={activeDocumentId}
            engine={selected.engine}
            supportsSql={supportsSql}
            onActivate={workbench.activateId}
            onClose={closeDocument}
            onNewQuery={() => void openQueryDocument()}
            onOpenActivity={() => openStableDocument("activity")}
          />
        )}

        <section className={`tab-body workbench-canvas area-${area}`}>
          {!selected ? (
            needsConn
          ) : area === "dashboard" ? (
            <Dashboards
              connection={selected}
              focusId={dashboardFocusId}
              onFocusConsumed={consumeDashboardFocus}
              onOpenAgent={openTerminalDock}
            />
          ) : !activeDocument ? (
            <div className="workbench-empty">
              <Icon name={supportsSql ? "play" : "list"} />
              <span className="muted">
                {supportsSql ? t("tabs.sql") : t("tabs.documents")}
              </span>
              <button
                className="btn primary"
                onClick={() => void openQueryDocument()}
              >
                <Icon name="plus" />
                {supportsSql ? t("tabs.sql") : t("tabs.documents")}
              </button>
            </div>
          ) : activeDocument.kind === "data" ? (
            safety ? (
              <TableData
                key={activeDocument.id}
                connection={selected}
                table={activeDocument.table}
                safety={safety}
              />
            ) : (
              safetyFallback
            )
          ) : activeDocument.kind === "schema" ? (
            safety ? (
              <SchemaExplorer
                key={activeDocument.id}
                connection={selected}
                selectedTable={null}
                safety={safety}
                onOpenTable={(table) => openTableDocument(selected, table)}
              />
            ) : (
              safetyFallback
            )
          ) : activeDocument.kind === "sql" ? (
            safety ? (
              <Sql
                key={activeDocument.id}
                connection={selected}
                safety={safety}
                draft={activeDocument.draft}
                setDraft={setActiveQueryDraft}
                title={activeDocument.title}
                setTitle={setActiveQueryTitle}
                persistedId={activeDocument.persistedId}
                revision={activeDocument.revision}
                recovered={activeDocument.recovered}
                onPersisted={applySavedQuery}
                onOpenAgent={openTerminalDock}
              />
            ) : (
              safetyFallback
            )
          ) : activeDocument.kind === "documents" ? (
            <Documents
              key={activeDocument.id}
              connection={selected}
              draft={activeDocument.draft}
            />
          ) : (
            <Activity
              key={activeDocument.id}
              connection={selected}
              onLoadSql={loadSql}
              initialAuditOpen={legacyAuditOpen.current}
              onInitialAuditOpenConsumed={() => {
                legacyAuditOpen.current = false;
              }}
            />
          )}
        </section>
      </>
    );
  }

  const showUpdateBadge = !!availableUpdate && !settingsOpen;
  return (
    <div
      className={`app${IS_MACOS ? " platform-macos" : ""}${
        showTerminalDock ? " terminal-open" : ""
      }${mobileExplorerOpen ? " mobile-explorer-open" : ""}`}
      style={{
        gridTemplateColumns: `48px ${sidebarW}px 5px minmax(0, 1fr) ${
          showTerminalDock && !terminalOverlay
            ? `${terminalDockWidth}px`
            : "0px"
        }`,
      }}
    >
      <WorkbenchRail
        area={settingsOpen ? null : area}
        dashboardAvailable={!selected || supportsSql}
        settingsOpen={settingsOpen}
        sidebarExpanded={!compactShell || mobileExplorerOpen}
        account={
          <WorkspaceAccount compact onScopeChanged={reloadWorkspaceScope} />
        }
        onArea={(next) => {
          const sameArea = next === area && !settingsOpen;
          setSettingsOpen(false);
          setEditing(null);
          setSchemaDiffGroupKey(null);
          setArea(next);
          if (next === "workspace" && selected) {
            openStableDocument("schema", false);
          }
          if (compactShell) {
            if (sameArea && mobileExplorerOpen) dismissMobileExplorer();
            else setMobileExplorerOpen(true);
          }
        }}
        onSettings={() => {
          setSettingsSection(undefined);
          setSettingsOpen(true);
          setSchemaDiffGroupKey(null);
          setMobileExplorerOpen(false);
        }}
      />
      {area === "dashboard" && !settingsOpen && editing === null && !activeSchemaGroup ? (
        <DashboardSidebar
          workspaceHeader={
            <WorkspaceSwitcher onNew={startNewConnection} onChanged={reloadWorkspaceScope} />
          }
          connections={conns}
          selectedId={selectedId}
          focusId={dashboardFocusId}
          onSelectConnection={(id) => selectConnection(id, "dashboard")}
          onFocus={setDashboardFocusId}
        />
      ) : (
        <DatabaseExplorer
          workspaceHeader={
            <WorkspaceSwitcher
              onNew={startNewConnection}
              onChanged={reloadWorkspaceScope}
            />
          }
          connections={conns}
          selectedId={selectedId}
          selectedTableKey={selectedTable ? tableKey(selectedTable) : null}
          activeSchemaGroupKey={schemaDiffGroupKey}
          onSelectConn={(id) => selectConnection(id, "workspace")}
          onOpenTable={openTableDocument}
          onOpenSchemaDiff={(group) => {
            setArea("workspace");
            setEditing(null);
            setSettingsOpen(false);
            setSchemaDiffGroupKey(group.key);
          }}
          onEdit={(conn) => {
            setEditing(conn);
            setSettingsOpen(false);
            setSchemaDiffGroupKey(null);
          }}
          onDeleted={async (id) => {
            await refresh();
            if (selectedId === id) {
              setSelectedId(null);
              workbench.reset();
            }
            if (schemaDiffGroupKey) setSchemaDiffGroupKey(null);
            setEditing((current) => {
              if (current && current !== "new" && current.id === id) return null;
              return current;
            });
          }}
          onConnectionUpdated={(updated) => {
            setConns((current) =>
              current.map((conn) => (conn.id === updated.id ? updated : conn)),
            );
            setEditing((current) => {
              if (current && current !== "new" && current.id === updated.id) {
                return updated;
              }
              return current;
            });
          }}
        />
      )}
      <button
        type="button"
        className="mobile-sidebar-scrim"
        aria-label={t("common.close")}
        aria-hidden={!mobileExplorerOpen}
        tabIndex={mobileExplorerOpen ? 0 : -1}
        onClick={() => dismissMobileExplorer(true)}
      />
      <div
        className="sidebar-resizer"
        title={t("app.dragResize")}
        onMouseDown={startSidebarDrag}
        onDoubleClick={() => {
          setSidebarW(SIDEBAR_DEFAULT);
          localStorage.setItem("sidebarW", String(SIDEBAR_DEFAULT));
        }}
      />
      <main
        ref={mainRef}
        className="main"
        tabIndex={-1}
        inert={mobileExplorerOpen ? true : undefined}
      >
        {renderMain()}
        {showUpdateBadge && (
          <div className="ds-attention-stack">
            {showUpdateBadge && (
              <button
                className="ds-attention-badge ds-tone-trust"
                onClick={openUpdateSettings}
                title={t("updates.badgeTitle")}
                aria-label={t("updates.badgeTitle")}
              >
                <Icon name="download" />
                <span>{t("updates.badge", { version: availableUpdate?.version ?? "" })}</span>
              </button>
            )}
          </div>
        )}
      </main>
      {showTerminalDock && selected && (
        <TerminalDock
          connection={selected}
          skillStatus={skillStatusQ.data ?? null}
          overlay={terminalOverlay}
          width={terminalDockWidth}
          unseen={unseen}
          onWidthChange={updateTerminalDockWidth}
          onOpenLogs={() => setAgentLogOpen(true)}
          onClose={closeTerminalDock}
        />
      )}
      {agentLogOpen && selected && (
        <AgentLogDialog
          connection={selected}
          onClose={() => setAgentLogOpen(false)}
        />
      )}
    </div>
  );
}
