import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  connectionId,
  retrySqlDocumentConflict,
  sqlDocumentConflict,
  sqlDocumentId,
  type SqlDocument,
} from "../sqlDocuments/domain";
import {
  findSqlParameters,
  materializeSqlParameters,
} from "../query/sqlParameters";
import { resolveSqlNamespaceAtCaret } from "../queries/resolveMode";
import { sqlExecutionMarkerPosition } from "../queries/editorStatus";
import {
  canFallbackFromCombinedRead,
  initialSqlRunPath,
} from "../queries/runPath";
import { queryDocument, stableDocument } from "./domain";
import {
  publishWorkbenchDraft,
  readWorkbenchDraft,
  seedWorkbenchDraft,
} from "./draftStore";
import { emptyWorkbenchState, workbenchReducer } from "./state";
import {
  appShellNavigationReducer,
  initialAppShellMode,
} from "../appShell/navigationState";
import {
  knowledgeSyncOverallPercent,
  knowledgeSyncRemainingFiles,
} from "../knowledge/syncProgress";
import {
  AppUpdaterController,
  type AppUpdateResource,
  type AppUpdaterDownloadEvent,
} from "../updater/controller";
import {
  connectionDiagnosticBlocksTest,
  diagnoseConnection,
} from "../connections/diagnostics";
import type { DriverDescriptor } from "../connections/domain";
import { switchConnectionSource } from "../connections/connectionEditorModel";
import {
  blankConnection,
  demoSqliteConnection,
  findDemoSqliteConnection,
} from "../connections/presets";
import { AnalysisSnapshotParameterField } from "../analysisArticles/AnalysisArticleVisualization";
import { actionSearchShortcutTargetIsEditable } from "../actionSearch/useActionSearchDialog";
import { tabFocusTargetIndex } from "../../design-system/tabKeyboard";
import {
  treeKeyboardMoveTarget,
  virtualTreeFocusIndex,
} from "../../design-system/treeKeyboard";
import {
  modalMouseDownShouldReachNativeDragRegion,
  ModalTitleBar,
} from "../../design-system/components/Modal";
import { queryResultPhase } from "../../lib/queryResultPhase";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function storedDocument(id = "doc-1"): SqlDocument {
  return {
    id: sqlDocumentId(id),
    connectionId: connectionId("db-1"),
    title: "Saved query",
    dialect: "postgresql",
    selectedDatabase: "app",
    selectedSchema: "billing",
    resolveMode: "script",
    content: "SELECT 1;",
    localRevision: 2,
    remoteId: null,
    remoteRevision: null,
    dirty: true,
    syncStatus: "local",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("workbench state ownership", () => {
  it("restores persisted SQL without removing the connection welcome document", () => {
    expect(queryResultPhase(undefined, new Error("offline"))).toBe("coldError");
    expect(queryResultPhase(undefined, null)).toBe("coldLoading");
    expect(queryResultPhase([], new Error("offline"))).toBe("staleError");
    expect(queryResultPhase([], null)).toBe("loaded");

    const welcome = stableDocument("db-1", "welcome");
    const initialized = workbenchReducer(emptyWorkbenchState, {
      type: "initialize",
      document: welcome,
    });
    const restored = workbenchReducer(initialized, {
      type: "restoreSql",
      connectionId: "db-1",
      documents: [storedDocument()],
      activateFirst: true,
    });

    expect(restored.documents.map((document) => document.kind)).toEqual([
      "welcome",
      "sql",
    ]);
    expect(restored.activeDocumentId).toContain(":sql:doc-1");
  });

  it("keeps one document instance and moves only the active pointer", async () => {
    const query = queryDocument("db-1", "sql");
    const first = workbenchReducer(emptyWorkbenchState, {
      type: "activate",
      document: query,
    });
    const second = workbenchReducer(first, {
      type: "activate",
      document: query,
    });

    expect(second.documents).toHaveLength(1);
    expect(second.activeDocumentId).toBe(query.id);

    seedWorkbenchDraft(query.id, query.draft ?? "");
    publishWorkbenchDraft(query.id, "SELECT 42;");
    expect(readWorkbenchDraft(query.id, "SELECT 0;")).toBe("SELECT 42;");
    seedWorkbenchDraft(query.id, "SELECT 84;");
    expect(readWorkbenchDraft(query.id, "SELECT 0;")).toBe("SELECT 84;");
    expect(second.documents[0]).toBe(query);

    const editing = appShellNavigationReducer(initialAppShellMode, {
      type: "openConnectionEditor",
      target: { kind: "existing", connectionId: "db-1" },
    });
    const settings = appShellNavigationReducer(editing, {
      type: "openSettings",
      section: "safety",
    });
    expect(settings).toEqual({
      kind: "settings",
      route: { kind: "workbench" },
      section: "safety",
    });
    expect(
      appShellNavigationReducer(settings, { type: "closeSettings" }),
    ).toEqual({ kind: "content", route: { kind: "workbench" } });

    const knowledge = appShellNavigationReducer(initialAppShellMode, {
      type: "openKnowledge",
      focus: {
        environmentId: "environment-1",
        view: "sources",
        resourceId: null,
        requestId: 1,
      },
    });
    expect(
      appShellNavigationReducer(knowledge, {
        type: "openSchemaDiff",
        groupKey: "schema-group",
      }),
    ).toEqual({
      kind: "content",
      route: { kind: "schemaDiff", groupKey: "schema-group" },
    });

    const progress = {
      sourceId: "source-1",
      projectEnvironmentId: "environment-1",
      displayName: "owner/repository",
      projectName: "Project",
      environmentName: "Production",
      phase: "indexing" as const,
      state: "claimed" as const,
      totalFiles: 1_200,
      completedFiles: 480,
      attempt: 0,
      startedAt: "2026-08-14T06:00:00Z",
      updatedAt: "2026-08-14T06:05:00Z",
      retryAt: null,
    };
    expect(knowledgeSyncOverallPercent(progress)).toBe(38);
    expect(knowledgeSyncRemainingFiles(progress)).toBe(720);
    expect(
      knowledgeSyncOverallPercent({
        ...progress,
        phase: "activating",
        completedFiles: progress.totalFiles,
      }),
    ).toBe(99);

    const firstDownload = deferred<void>();
    const retryDownload = deferred<void>();
    const relaunch = deferred<void>();
    const downloadCallbacks: Array<
      ((event: AppUpdaterDownloadEvent) => void) | undefined
    > = [];
    let checkCalls = 0;
    let downloadCalls = 0;
    let closeCalls = 0;
    let relaunchCalls = 0;
    const update: AppUpdateResource = {
      version: "0.3.55",
      body: "Release notes",
      downloadAndInstall(callback) {
        downloadCallbacks.push(callback);
        const operation = downloadCalls === 0 ? firstDownload : retryDownload;
        downloadCalls += 1;
        return operation.promise;
      },
      async close() {
        closeCalls += 1;
      },
    };
    const updater = new AppUpdaterController({
      async currentVersion() {
        return "0.3.54";
      },
      async check() {
        checkCalls += 1;
        return update;
      },
      async relaunch() {
        relaunchCalls += 1;
        return relaunch.promise;
      },
      errorMessage: (error) => String(error),
    });

    const firstCheck = updater.refresh();
    expect(updater.refresh()).toBe(firstCheck);
    await firstCheck;
    expect(checkCalls).toBe(1);
    expect(updater.getSnapshot()).toMatchObject({
      phase: "available",
      currentVersion: "0.3.54",
      availableVersion: "0.3.55",
    });

    const stopObserving = updater.subscribe(() => undefined);
    const failedInstall = updater.install();
    expect(updater.install()).toBe(failedInstall);
    downloadCallbacks[0]?.({
      event: "Started",
      data: { contentLength: 1_000 },
    });
    downloadCallbacks[0]?.({
      event: "Progress",
      data: { chunkLength: 400 },
    });
    expect(updater.getSnapshot()).toMatchObject({
      phase: "downloading",
      downloadedBytes: 400,
      totalBytes: 1_000,
    });
    stopObserving();
    expect(updater.getSnapshot().downloadedBytes).toBe(400);
    firstDownload.reject(new Error("network"));
    await failedInstall;
    expect(updater.getSnapshot().phase).toBe("error");
    expect(closeCalls).toBe(0);

    const retriedInstall = updater.install();
    expect(updater.install()).toBe(retriedInstall);
    retryDownload.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(updater.getSnapshot().phase).toBe("ready");
    expect(relaunchCalls).toBe(1);
    expect(closeCalls).toBe(0);
    relaunch.resolve();
    await retriedInstall;
    expect(downloadCalls).toBe(2);
    expect(closeCalls).toBe(1);
    updater.dispose();
  });

  it("creates the welcome fallback when the last SQL tab closes", () => {
    const query = queryDocument("db-1", "sql");
    const state = workbenchReducer(emptyWorkbenchState, {
      type: "activate",
      document: query,
    });
    const closed = workbenchReducer(state, {
      type: "close",
      id: query.id,
      connectionId: "db-1",
      keepWelcomeFallback: true,
    });

    expect(closed.documents).toEqual([stableDocument("db-1", "welcome")]);
    expect(closed.activeDocumentId).toBe("db-1:welcome");
  });

  it("applies a successful save through the one state reducer", () => {
    const query = queryDocument("db-1", "sql", "SELECT 0;");
    const state = workbenchReducer(emptyWorkbenchState, {
      type: "activate",
      document: query,
    });
    const databaseSelected = workbenchReducer(state, {
      type: "updateSelectedDatabase",
      id: query.id,
      selectedDatabase: "analytics",
    });
    const databaseDocument = databaseSelected.documents[0];
    expect(databaseDocument?.kind === "sql" && databaseDocument.selectedSchema).toBeNull();
    const selected = workbenchReducer(databaseSelected, {
      type: "updateSelectedSchema",
      id: query.id,
      selectedSchema: "public",
    });
    const resolved = workbenchReducer(selected, {
      type: "updateResolveMode",
      id: query.id,
      resolveMode: "playground",
    });
    const persisted = workbenchReducer(resolved, {
      type: "persist",
      id: query.id,
      document: storedDocument(),
    });
    const current = persisted.documents[0];

    expect(current?.kind).toBe("sql");
    if (current?.kind !== "sql") throw new Error("expected SQL document");
    expect(current.draft).toBe("SELECT 1;");
    expect(current.revision).toBe(2);
    expect(current.selectedDatabase).toBe("app");
    expect(current.selectedSchema).toBe("billing");
    expect(current.resolveMode).toBe("script");
    expect(
      resolveSqlNamespaceAtCaret({
        sqlBeforeCaret:
          "SELECT * FROM users;\nSET search_path TO billing;\nSELECT * FROM invoices",
        engine: "postgres",
        mode: current.resolveMode,
        selectedNamespace: "public",
        namespaceOptions: ["billing", "public"],
      }),
    ).toBe("billing");
    expect(
      resolveSqlNamespaceAtCaret({
        sqlBeforeCaret:
          "-- SET search_path TO billing;\nSELECT 'USE billing' AS note",
        engine: "postgres",
        mode: "script",
        selectedNamespace: "public",
        namespaceOptions: ["billing", "public"],
      }),
    ).toBe("public");

    expect(initialSqlRunPath(true, "SELECT * FROM invoices")).toBe(
      "combinedReadStream",
    );
    expect(
      initialSqlRunPath(true, "-- invoice list\nSELECT * FROM invoices"),
    ).toBe("combinedReadStream");
    expect(
      initialSqlRunPath(
        true,
        "UPDATE invoices SET state = state WHERE 1 = 0",
      ),
    ).toBe("plannedReadStream");
    expect(
      initialSqlRunPath(
        true,
        "WITH changed AS (DELETE FROM invoices RETURNING id) SELECT * FROM changed",
      ),
    ).toBe("plannedReadStream");
    expect(
      initialSqlRunPath(true, "SELECT * FROM invoices FOR UPDATE"),
    ).toBe("plannedReadStream");
    expect(initialSqlRunPath(false, "SELECT * FROM invoices")).toBe(
      "plannedReadStream",
    );
    expect(canFallbackFromCombinedRead("proposalRequired")).toBe(true);
    expect(canFallbackFromCombinedRead("network")).toBe(false);

    const parameterSql =
      "SELECT * FROM invoices WHERE account_id = :account AND created_at >= ${since}";
    const parameters = findSqlParameters(parameterSql, "postgres");
    expect(materializeSqlParameters(parameterSql, parameters, {
      "named:account": "42",
      "named:since": "DATE '2026-01-01'",
    })).toBe(
      "SELECT * FROM invoices WHERE account_id = 42 AND created_at >= DATE '2026-01-01'",
    );

    const executedSql = "SELECT 1;\nSELECT 2;";
    const executionStatus = {
      source: { sql: "SELECT 2;", from: 10, to: 19 },
      state: "completed" as const,
      label: "Completed",
    };
    expect(sqlExecutionMarkerPosition(executedSql, executionStatus)).toBe(19);
    expect(
      sqlExecutionMarkerPosition("SELECT 1;\nSELECT 3;", executionStatus),
    ).toBeNull();

    const conflict = sqlDocumentConflict(storedDocument(), {
      title: "Local query",
      selectedDatabase: "analytics",
      selectedSchema: "public",
      resolveMode: "playground",
      content: "SELECT * FROM events;",
    });
    expect(retrySqlDocumentConflict(conflict)).toEqual({
      expectedRevision: 2,
      title: "Local query",
      selectedDatabase: "analytics",
      selectedSchema: "public",
      resolveMode: "playground",
      content: "SELECT * FROM events;",
    });

    const postgresDriver: DriverDescriptor = {
      id: "sqlx-postgres",
      name: "PostgreSQL",
      engine: "postgres",
      version: "1",
      installMode: "bundled",
      installState: "installed",
      supportedProviders: ["auto", "generic"],
      capabilities: ["sql"],
      recommended: true,
    };
    const nameless = { ...blankConnection(), database: "app" };
    const namelessDiagnostics = diagnoseConnection(
      nameless,
      [],
      [postgresDriver],
      false,
      false,
    );
    expect(namelessDiagnostics.map(({ code }) => code)).toEqual([
      "nameRequired",
    ]);
    expect(namelessDiagnostics.some(connectionDiagnosticBlocksTest)).toBe(
      false,
    );
    expect(
      namelessDiagnostics.some(({ tone }) => tone === "danger"),
    ).toBe(true);

    const mongo = switchConnectionSource(
      {
        ...nameless,
        driverId: postgresDriver.id,
        extraParams: {
          "dopedb.timeZone": "UTC",
          "dopedb.keepAliveSeconds": "30",
          "dopedb.startupScript": "SET application_name = 'dopedb'",
          sslrootcert: "/tmp/ca.pem",
        },
        schemaGroup: "public",
      },
      "mongodb",
      "generic",
    );
    expect(mongo).toMatchObject({
      engine: "mongodb",
      provider: "generic",
      driverId: null,
      port: 27017,
      sslmode: "prefer",
      schemaGroup: null,
      username: "",
      extraParams: {},
    });
    const mongoDiagnostics = diagnoseConnection(
      { ...mongo, database: "app" },
      [],
      [
        {
          ...postgresDriver,
          id: "mongodb",
          name: "MongoDB",
          engine: "mongodb",
          supportedProviders: ["generic"],
        },
      ],
      false,
      false,
    );
    expect(
      mongoDiagnostics.some(
        ({ fieldId }) => fieldId === "connection-username",
      ),
    ).toBe(false);

    const demo = demoSqliteConnection("/tmp/demos/dopedb-demo-v1.sqlite");
    expect(findDemoSqliteConnection([demo], demo.database)).toBe(demo);

    const snapshotParameter = renderToStaticMarkup(
      createElement(AnalysisSnapshotParameterField, {
        parameter: {
          id: "include-archived",
          label: "Include archived",
          type: "boolean",
          required: true,
          defaultValue: false,
          options: [],
        },
        value: true,
      }),
    );
    expect(snapshotParameter).toContain("Include archived");
    expect(snapshotParameter).toContain("true");
    expect(snapshotParameter).not.toMatch(/<(?:input|select|textarea)\b/);
    expect(
      actionSearchShortcutTargetIsEditable({
        closest: (selector: string) => selector.includes(".cm-content"),
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      actionSearchShortcutTargetIsEditable({
        closest: () => null,
      } as unknown as EventTarget),
    ).toBe(false);
    expect(tabFocusTargetIndex(0, 3, "previous")).toBe(2);
    expect(tabFocusTargetIndex(2, 3, "next")).toBe(0);
    expect(tabFocusTargetIndex(1, 3, "start")).toBe(0);
    expect(tabFocusTargetIndex(1, 3, "end")).toBe(2);
    expect(tabFocusTargetIndex(-1, 3, "next")).toBeNull();

    const virtualTreeItems = [
      { key: "connection", parentKey: null },
      ...Array.from({ length: 5_000 }, (_, index) => ({
        key: `table:${index}`,
        parentKey: "connection",
      })),
    ];
    expect(
      treeKeyboardMoveTarget(virtualTreeItems, "connection", "ArrowRight"),
    ).toBe("table:0");
    expect(
      treeKeyboardMoveTarget(virtualTreeItems, "table:2499", "ArrowDown"),
    ).toBe("table:2500");
    expect(
      treeKeyboardMoveTarget(virtualTreeItems, "table:2500", "ArrowUp"),
    ).toBe("table:2499");
    expect(
      treeKeyboardMoveTarget(virtualTreeItems, "table:2500", "ArrowLeft"),
    ).toBe("connection");
    expect(
      treeKeyboardMoveTarget(virtualTreeItems, "table:0", "End"),
    ).toBe("table:4999");
    expect(
      treeKeyboardMoveTarget(virtualTreeItems, "table:4999", "Home"),
    ).toBe("connection");
    expect(
      virtualTreeFocusIndex(
        virtualTreeItems.map((treeItem) => ({ treeItem })),
        "table:4999",
      ),
    ).toBe(5_000);

    const modalTitleBar = renderToStaticMarkup(
      createElement(ModalTitleBar, {
        title: "Data Sources",
        titleId: "data-sources-title",
        closeLabel: "Close",
        onClose: () => undefined,
      }),
    );
    expect(modalTitleBar).toContain('data-tauri-drag-region="deep"');
    expect(modalTitleBar).toContain('data-tauri-drag-region="false"');
    expect(modalTitleBar).not.toContain('role="presentation"');
    const dragTarget = (value: string | null) => ({
      getAttribute: (name: string) =>
        name === "data-tauri-drag-region" ? value : null,
    }) as unknown as EventTarget;
    expect(
      modalMouseDownShouldReachNativeDragRegion([
        dragTarget(null),
        dragTarget("deep"),
      ]),
    ).toBe(true);
    expect(
      modalMouseDownShouldReachNativeDragRegion([
        dragTarget("false"),
        dragTarget("deep"),
      ]),
    ).toBe(false);
    expect(
      modalMouseDownShouldReachNativeDragRegion([dragTarget(null)]),
    ).toBe(false);
  });
});
