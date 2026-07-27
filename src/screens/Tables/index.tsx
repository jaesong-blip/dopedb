// Table data view (DopeDB-style data editor). Server-side pagination with a STABLE
// ORDER BY (primary key) + a real COUNT(*) so pages never repeat/skip rows and the
// total is exact ("rows X-Y of Z"). Column sort and per-column filters go through the
// same sqlBuild helpers. Row edits (insert/update/delete) are generated as SQL and
// staged into one optimistic transaction, then routed through the immutable proposal /
// approval / audit pipeline. Reads still auto-run and never need approval.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  approveOperation,
  proposeTableChanges,
  rejectOperation,
  runScript,
} from "../../ipc/commands";
import type {
  CatalogTable,
  QueryResult,
  SafetySettings,
  ScriptOperationProposal,
  ScriptOutcome,
} from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import type { ConnectionProfile } from "../../features/connections/domain";
import DataGrid from "../../components/DataGrid";
import { Icon } from "../../components/Icon";
import CellViewer from "../../components/CellViewer";
import RowEditor, { type RowEditorSubmission } from "../../components/RowEditor";
import JobPanel from "../../components/JobPanel";
import Skeleton from "../../components/Skeleton";
import ToolbarMenu from "../../components/ToolbarMenu";
import { useToast } from "../../components/Toast";
import { isDocumentEngine } from "../../lib/capabilities";
import { documentsToGrid } from "../../lib/documentGrid";
import {
  documentCountQuery,
  documentRowsQuery,
  tableRowsQuery,
} from "../../lib/queries";
import { tableKey, tableLabel } from "../../lib/tableRef";
import { downloadCsv, downloadJson, stamp } from "../../lib/export";
import { useCatalogTableMetadata } from "./catalogTable";
import { useI18n } from "../../lib/i18n";
import {
  buildDelete,
  cellToInput,
  hasNonScalarPk,
  pkColumns,
  type GridSort,
} from "../../lib/sqlBuild";
import "./tables.css";

const FILTER_DEBOUNCE_MS = 250;

function sameFilters(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

const PAGE = 100;

// Compact page controls shared by SQL and MongoDB. Text lives in accessible labels and
// tooltips; icons keep the data toolbar from stealing width from the grid.
function Pager({
  page,
  pageSize,
  total,
  rows,
  busy,
  onPage,
  onRefresh,
  children,
}: {
  page: number;
  pageSize: number;
  total: number | null;
  rows: number;
  busy: boolean;
  onPage: (page: number) => void;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const lastPage = total != null ? Math.max(0, Math.ceil(total / pageSize) - 1) : null;
  const hasPrev = page > 0;
  const hasNext = total != null ? page < (lastPage ?? 0) : rows === pageSize;
  return (
    <div
      className="table-pager ds-command-group ds-control-row"
      role="group"
      aria-label={t("tables.pagination")}
    >
      <button
        className="btn small icon-only table-edge-page-action"
        disabled={busy || !hasPrev}
        onClick={() => onPage(0)}
        title={t("common.first")}
        aria-label={t("common.first")}
      >
        <Icon name="chevronsLeft" />
      </button>
      <button
        className="btn small icon-only"
        disabled={busy || !hasPrev}
        onClick={() => onPage(page - 1)}
        title={t("common.prev")}
        aria-label={t("common.prev")}
      >
        <Icon name="arrowLeft" />
      </button>
      <span className="muted page-ind">
        {t("tables.page", { page: page + 1 })}
        {lastPage != null && ` / ${lastPage + 1}`}
      </span>
      <button
        className="btn small icon-only"
        disabled={busy || !hasNext}
        onClick={() => onPage(page + 1)}
        title={t("common.next")}
        aria-label={t("common.next")}
      >
        <Icon name="arrowRight" />
      </button>
      <button
        className="btn small icon-only table-edge-page-action"
        disabled={busy || lastPage == null || !hasNext}
        onClick={() => lastPage != null && onPage(lastPage)}
        title={t("tables.last")}
        aria-label={t("tables.last")}
      >
        <Icon name="chevronsRight" />
      </button>
      <button
        className="btn small icon-only refresh table-refresh-action"
        disabled={busy}
        aria-label={t("common.refresh")}
        title={t("common.refresh")}
        onClick={onRefresh}
      >
        {busy ? "…" : <Icon name="refresh" />}
      </button>
      {children}
    </div>
  );
}

type Editor = { mode: "insert" | "edit" | "duplicate"; initial: Record<string, string | null> };
type CellSel = { value: unknown; column: string };
type StagedWrite = {
  id: string;
  sql: string;
  rationale?: string;
};
type PendingDelete = {
  key: Record<string, string | null>;
  original: Record<string, string | null>;
};

export default function TableData({
  connection,
  table,
  safety,
}: {
  connection: ConnectionProfile;
  table: CatalogTable;
  safety: SafetySettings;
}) {
  // MongoDB has no SQL path at all — read-only paging over documentRowsQuery, no
  // filters/sort/row-editing. Branch only; the SQL implementation below is unchanged.
  if (isDocumentEngine(connection.engine)) {
    return <MongoTableData connection={connection} table={table} />;
  }
  return <SqlTableData connection={connection} table={table} safety={safety} />;
}

function SqlTableData({
  connection,
  table: requestedTable,
  safety,
}: {
  connection: ConnectionProfile;
  table: CatalogTable;
  safety: SafetySettings;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const engine = connection.engine;
  const { table, snapshotQuery } = useCatalogTableMetadata(connection.id, requestedTable);
  const [writeErr, setWriteErr] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<GridSort | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  // Typing in a filter must not fire a query per keystroke, so the query reads the settled
  // value while the inputs stay controlled by `filters`.
  const [appliedFilters, setAppliedFilters] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [cellSel, setCellSel] = useState<CellSel | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [staged, setStaged] = useState<StagedWrite[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [stagedProposal, setStagedProposal] =
    useState<ScriptOperationProposal | null>(null);
  const [stagedConfirmation, setStagedConfirmation] = useState("");
  const [stagedRunning, setStagedRunning] = useState(false);
  // Readable confirm gate for DELETE: PK pairs of the target row, mirroring how
  // insert/edit/duplicate pass through RowEditor before entering the staged transaction.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [structure, setStructure] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);

  const pageSize = Math.min(PAGE, safety.maxRows || PAGE);
  const key = tableKey(table);

  // Reset the whole view when the selected table changes. Done during render (not in an
  // effect) so the row query never fires once with the new table and the old table's
  // filters, sort, or page.
  const [viewKey, setViewKey] = useState(key);
  if (viewKey !== key) {
    setViewKey(key);
    setPage(0);
    setSort(null);
    setFilters({});
    setAppliedFilters({});
    setSelected(null);
    setCellSel(null);
    setEditor(null);
    setStaged([]);
    setReviewing(false);
    setStagedProposal(null);
    setStagedConfirmation("");
    setStagedRunning(false);
    setPendingDelete(null);
    setStructure(false);
    setJobsOpen(false);
    setWriteErr(null);
  }

  const rowsQuery = useQuery({
    ...tableRowsQuery({
      connectionId: connection.id,
      engine,
      table,
      filters: appliedFilters,
      sort,
      pageSize,
      page,
    }),
    // Paging and filtering repaint the previous page (dimmed) instead of blanking the grid.
    placeholderData: keepPreviousData,
  });
  const result = rowsQuery.data?.result ?? null;
  const total = rowsQuery.data?.total ?? null;
  const busy = rowsQuery.isFetching;
  const err = writeErr ?? (rowsQuery.error ? errMessage(rowsQuery.error) : null);
  const catalogRelation = snapshotQuery.data?.relations.find(
    (candidate) =>
      candidate.object.name === table.name &&
      candidate.object.namespace === table.schema,
  );

  // Settling a filter always returns to the first page; both land in one render so only the
  // final query key is ever fetched. The equality guard keeps this inert on mount and on a
  // table switch, where a stray timer would otherwise yank the user back to page 0.
  useEffect(() => {
    if (sameFilters(filters, appliedFilters)) return;
    const timer = window.setTimeout(() => {
      setAppliedFilters(filters);
      setPage(0);
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filters, appliedFilters]);
  // Row editing needs a PK we can match on. No PK, or a PK whose rendered cell value can't
  // round-trip to a literal (binary/json/array/composite), both disable it — same as noPk.
  const nonScalarPk = hasNonScalarPk(table);
  const canEdit = pkColumns(table).length > 0 && !nonScalarPk;
  const activeFilters = Object.values(filters).filter((v) => v.trim()).length;

  // Fresh rows landed, so any row/cell the user had selected now points at data that may
  // no longer be there, and a stale write error no longer describes what is on screen.
  useEffect(() => {
    setSelected(null);
    setCellSel(null);
    setWriteErr(null);
  }, [rowsQuery.dataUpdatedAt]);

  const rows = result?.rowCount ?? 0;
  const from = rows === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + rows;

  function cycleSort(col: string) {
    setSort((s) =>
      !s || s.col !== col
        ? { col, dir: "asc" }
        : s.dir === "asc"
          ? { col, dir: "desc" }
          : null,
    );
    setPage(0);
  }

  const selRow = selected != null && result ? result.rows[selected] : null;

  function rowMap(row: unknown[]): Record<string, string | null> {
    const m: Record<string, string | null> = {};
    result!.columns.forEach((c, i) => (m[c] = cellToInput(row[i])));
    return m;
  }

  function openEdit(mode: Editor["mode"]) {
    setJobsOpen(false);
    if (mode === "insert") setEditor({ mode, initial: {} });
    else if (selRow) setEditor({ mode, initial: rowMap(selRow) });
    setCellSel(null);
  }

  // Open a readable confirm (PK pairs) instead of staging a DELETE immediately —
  // Delete sits next to Duplicate, so a mis-click shouldn't be one approval from a wipe.
  function doDelete() {
    if (!selRow || !result) return;
    const pkVals: Record<string, string | null> = {};
    for (const c of pkColumns(table)) {
      const i = result.columns.indexOf(c.name);
      pkVals[c.name] = i >= 0 ? cellToInput(selRow[i]) : null;
    }
    setPendingDelete({ key: pkVals, original: rowMap(selRow) });
    setEditor(null);
    setCellSel(null);
    setJobsOpen(false);
  }

  function stageWrite(write: RowEditorSubmission) {
    setStaged((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        sql: write.sql,
        rationale: write.rationale,
      },
    ]);
    setEditor(null);
    setCellSel(null);
    setReviewing(false);
    setStagedProposal(null);
  }

  // Confirmed: build the DELETE and add it to the staged transaction.
  function armDelete() {
    if (!pendingDelete) return;
    try {
      stageWrite({
        sql: buildDelete(
          engine,
          table,
          pendingDelete.key,
          pendingDelete.original,
        ),
        rationale: t("rowEditor.rationaleDelete", { table: table.name }),
        collapseSql: true,
      });
      setPendingDelete(null);
    } catch (e) {
      setWriteErr(errMessage(e));
    }
  }

  function copyRow(asJson: boolean) {
    if (!selRow || !result) return;
    const text = asJson
      ? JSON.stringify(
          Object.fromEntries(result.columns.map((c, i) => [c, selRow[i] ?? null])),
          null,
          2,
        )
      : selRow
          .map((v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)))
          .join("\t");
    void navigator.clipboard.writeText(text);
    toast(t("tables.copyRow"));
  }

  async function prepareStagedChanges() {
    if (!staged.length || stagedRunning) return;
    const fingerprint = snapshotQuery.data?.fingerprint;
    if (!fingerprint) {
      setWriteErr(
        snapshotQuery.error
          ? errMessage(snapshotQuery.error)
          : t("tables.catalogRequired"),
      );
      return;
    }
    setStagedRunning(true);
    setWriteErr(null);
    try {
      const proposal = await proposeTableChanges(
        connection.id,
        staged.map((change) => change.sql),
        fingerprint,
      );
      setStagedProposal(proposal);
      setReviewing(true);
      if (!proposal.approvalRequired) {
        const outcome = await runScript(proposal.operationId);
        finishStagedChanges(outcome);
      }
    } catch (error) {
      setWriteErr(errMessage(error));
    } finally {
      setStagedRunning(false);
    }
  }

  async function approveStagedChanges() {
    if (!stagedProposal || stagedRunning) return;
    setStagedRunning(true);
    setWriteErr(null);
    try {
      await approveOperation(
        stagedProposal.operationId,
        stagedProposal.payloadHash,
        stagedProposal.confirmationPhrase ? stagedConfirmation : undefined,
      );
      finishStagedChanges(await runScript(stagedProposal.operationId));
    } catch (error) {
      setWriteErr(errMessage(error));
    } finally {
      setStagedRunning(false);
    }
  }

  async function rejectStagedChanges() {
    if (!stagedProposal || stagedRunning) return;
    try {
      await rejectOperation(
        stagedProposal.operationId,
        stagedProposal.payloadHash,
      );
    } catch (error) {
      setWriteErr(errMessage(error));
    } finally {
      setStagedProposal(null);
      setStagedConfirmation("");
      setReviewing(false);
    }
  }

  function finishStagedChanges(outcome: ScriptOutcome) {
    const conflict = outcome.statements.find((statement) =>
      statement.error?.includes("optimistic concurrency conflict"),
    );
    if (!outcome.committed || conflict) {
      setWriteErr(
        conflict?.error ??
          outcome.statements.find((statement) => statement.error)?.error ??
          t("tables.changeSetRolledBack"),
      );
      return;
    }
    toast(t("tables.rowsWritten", { count: outcome.statements.length }));
    setStaged([]);
    setReviewing(false);
    setStagedProposal(null);
    setStagedConfirmation("");
    setEditor(null);
    setPendingDelete(null);
    setWriteErr(null);
    void rowsQuery.refetch();
  }

  const noEditTitle = nonScalarPk
    ? t("tables.nonScalarPk")
    : t("tables.noTablePk");
  const panelOpen = reviewing || !!editor || !!cellSel || !!pendingDelete;

  return (
    <div className="table-data">
      <div className="table-data-context">
        <div className="table-data-identity">
          <Icon name={table.kind === "view" ? "view" : "table"} />
          <strong>{tableLabel(engine, table)}</strong>
          <span className="ds-context-badge">
            {table.kind === "view" ? t("schema.view") : t("tables.sourceTable")}
          </span>
        </div>
        <div className="ds-meta-row">
          <span>{t("tables.cols", { count: table.columns.length })}</span>
          <span className="ds-meta-dot" />
          <span>LIMIT {pageSize.toLocaleString()}</span>
          {result && (
            <>
              <span className="ds-meta-dot" />
              <span>
                {total != null
                  ? t("tables.rowRangeTotal", {
                      from,
                      to,
                      total: total.toLocaleString(),
                    })
                  : t("tables.rowRange", { from, to })}
                {result.truncated ? " (truncated)" : ""}
              </span>
              <span className="ds-meta-dot" />
              <span>{result.durationMs} ms</span>
            </>
          )}
        </div>
      </div>

      <div
        className="grid-toolbar ds-data-toolbar ds-control-row"
        role="toolbar"
        aria-label={t("tables.querySurface")}
      >
        <div className="table-toolbar-scroll scrollbar-sleek">
          <div className="ds-toolbar-group">
            <button
              className="btn small ghost table-row-action"
              disabled={!canEdit}
              title={canEdit ? t("tables.insert") : noEditTitle}
              aria-label={t("tables.insert")}
              onClick={() => openEdit("insert")}
            >
              <Icon name="plus" />
              <span className="table-action-label">{t("tables.insert")}</span>
            </button>
            <button
              className="btn small ghost table-row-action"
              disabled={!canEdit || selected == null}
              title={canEdit ? t("tables.edit") : noEditTitle}
              aria-label={t("tables.edit")}
              onClick={() => openEdit("edit")}
            >
              <Icon name="pencil" />
              <span className="table-action-label">{t("tables.edit")}</span>
            </button>
            <button
              className="btn small danger-ghost table-row-action"
              disabled={!canEdit || selected == null}
              title={canEdit ? t("tables.delete") : noEditTitle}
              aria-label={t("tables.delete")}
              onClick={doDelete}
            >
              <Icon name="trash" />
              <span className="table-action-label">{t("tables.delete")}</span>
            </button>
            {staged.length > 0 && (
              <>
                <button
                  className="btn small active"
                  onClick={() => {
                    setReviewing(true);
                    setEditor(null);
                    setPendingDelete(null);
                    setCellSel(null);
                  }}
                  title={t("tables.reviewStaged")}
                >
                  <Icon name="check" />
                  {t("tables.stagedCount", { count: staged.length })}
                </button>
                <button
                  className="btn small icon-only"
                  onClick={() => {
                    setStaged([]);
                    setReviewing(false);
                    setStagedProposal(null);
                  }}
                  title={t("tables.discardStaged")}
                  aria-label={t("tables.discardStaged")}
                >
                  <Icon name="close" />
                </button>
              </>
            )}
          </div>
          <span className="table-toolbar-divider" aria-hidden="true" />
          <div className="table-query-state" aria-label={t("tables.querySurface")}>
            <span
              className={activeFilters ? "table-state active" : "table-state"}
              title={t("tables.filterState")}
            >
              <Icon name="filter" />
              {activeFilters
                ? t(activeFilters > 1 ? "tables.activeFiltersPlural" : "tables.activeFilters", {
                    count: activeFilters,
                  })
                : t("tables.noFilters")}
            </span>
            <span
              className={sort ? "table-state active" : "table-state"}
              title={t("tables.sortState")}
            >
              <Icon name="sort" />
              {sort ? `${sort.col} ${sort.dir.toUpperCase()}` : t("tables.unsorted")}
            </span>
            <span
              className={safety.allowWrites ? "table-state risk" : "table-state"}
              title={t("tables.writePolicy")}
            >
              <Icon name={safety.allowWrites ? "pencil" : "circleSlash"} />
              {safety.allowWrites
                ? t("tables.writePolicyWrites")
                : t("tables.writePolicyReadonly")}
            </span>
            {activeFilters > 0 && (
              <button className="btn small" onClick={() => setFilters({})}>
                {t("tables.clear")}
              </button>
            )}
          </div>
        </div>
        <Pager
          page={page}
          pageSize={pageSize}
          total={total}
          rows={rows}
          busy={busy}
          onPage={setPage}
          onRefresh={() => void rowsQuery.refetch()}
        >
          <button
            className={`btn small icon-only table-secondary-action${jobsOpen ? " active" : ""}`}
            disabled={!catalogRelation}
            aria-expanded={jobsOpen}
            title={
              catalogRelation
                ? t("jobs.open")
                : t("tables.catalogRequired")
            }
            aria-label={t("jobs.open")}
            onClick={() => {
              setJobsOpen((open) => !open);
              setReviewing(false);
              setEditor(null);
              setPendingDelete(null);
              setCellSel(null);
            }}
          >
            <Icon name="download" />
          </button>
          <button
            className={`btn small icon-only table-secondary-action${structure ? " active" : ""}`}
            aria-expanded={structure}
            title={t("tables.structureTitle")}
            aria-label={t("tables.structureTitle")}
            onClick={() => setStructure((s) => !s)}
          >
            <Icon name="columns" />
          </button>
          <ToolbarMenu label={t("tables.more")} icon="moreVertical">
            <button
              type="button"
              role="menuitem"
              className="ds-menu-item"
              disabled={busy}
              onClick={() => void rowsQuery.refetch()}
            >
              <Icon name="refresh" />
              {t("common.refresh")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="ds-menu-item"
              disabled={!catalogRelation}
              onClick={() => {
                setJobsOpen((open) => !open);
                setReviewing(false);
                setEditor(null);
                setPendingDelete(null);
                setCellSel(null);
              }}
            >
              <Icon name="download" />
              {t("jobs.open")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="ds-menu-item"
              onClick={() => setStructure((current) => !current)}
            >
              <Icon name="columns" />
              {t("tables.structureTitle")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="ds-menu-item"
              disabled={!canEdit || selected == null}
              title={canEdit ? undefined : noEditTitle}
              onClick={() => openEdit("duplicate")}
            >
              <Icon name="copy" />
              {t("tables.duplicate")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="ds-menu-item"
              disabled={selected == null}
              onClick={() => copyRow(false)}
            >
              <Icon name="copy" />
              {t("tables.copyTsv")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="ds-menu-item"
              disabled={selected == null}
              onClick={() => copyRow(true)}
            >
              <Icon name="copy" />
              {t("tables.copyJson")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="ds-menu-item"
              disabled={!rows}
              title={t("tables.exportPageTitle")}
              onClick={() =>
                result && downloadCsv(`${table.name}-page${page + 1}-${stamp()}`, result.columns, result.rows)
              }
            >
              <Icon name="download" />
              {t("tables.exportCsv")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="ds-menu-item"
              disabled={!rows}
              title={t("tables.exportPageTitle")}
              onClick={() =>
                result && downloadJson(`${table.name}-page${page + 1}-${stamp()}`, result.columns, result.rows)
              }
            >
              <Icon name="download" />
              {t("tables.exportJson")}
            </button>
          </ToolbarMenu>
        </Pager>
      </div>

      {/* Introspected metadata already on the prop — no backend call. Collapsed by default. */}
      {structure && (
        <div className="table-structure">
          <table className="struct-table">
            <thead>
              <tr>
                <th>{t("tables.column")}</th>
                <th>{t("tables.type")}</th>
                <th>{t("tables.nullable")}</th>
                <th>PK</th>
              </tr>
            </thead>
            <tbody>
              {table.columns.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="muted">{c.dataType}</td>
                  <td>{c.nullable ? t("common.yes") : t("common.no")}</td>
                  <td>{c.pk ? "PK" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="struct-meta">
            <div>
              <strong>{t("tables.indexes")}</strong>
              {table.indexes.length ? (
                <ul>
                  {table.indexes.map((ix) => (
                    <li key={ix.name}>
                      {ix.name}
                      {ix.unique ? ` (${t("tables.unique")})` : ""}: {ix.columns.join(", ")}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted"> {t("common.none")}</span>
              )}
            </div>
            <div>
              <strong>{t("tables.foreignKeys")}</strong>
              {table.foreignKeys.length ? (
                <ul>
                  {table.foreignKeys.map((fk) => (
                    <li key={`${fk.column}-${fk.referencesTable}-${fk.referencesColumn}`}>
                      {fk.column} → {fk.referencesSchema ? `${fk.referencesSchema}.` : ""}
                      {fk.referencesTable}.{fk.referencesColumn}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted"> {t("common.none")}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {err && <div className="error">{err}</div>}

      {/* Dim (not blank) the stale grid while paging/sorting/filtering re-queries. */}
      <div className={busy && result ? "table-data-body busy" : "table-data-body"}>
        {result ? (
          result.rows.length ? (
            <DataGrid
              result={result}
              startIndex={page * pageSize}
              sort={sort}
              onSort={cycleSort}
              filters={filters}
              onFilter={(col, value) => setFilters((f) => ({ ...f, [col]: value }))}
              selectedRow={selected}
              onSelectRow={setSelected}
              onCellClick={(value, i, column) => {
                setSelected(i);
                setCellSel({ value, column });
                setJobsOpen(false);
              }}
              columnMeta={Object.fromEntries(
                table.columns.map((column) => [
                  column.name,
                  { dataType: column.dataType, pk: column.pk },
                ]),
              )}
            />
          ) : busy ? (
            // Reloading (filter cleared / table switched) — the stale zero-row result would
            // otherwise flash a wrong "Table is empty." against the now-live filter state.
            <div className="muted loading">{t("tables.loadingRows")}</div>
          ) : (
            // Loaded but zero rows: distinguish an empty table from a filter that matched nothing.
            <div className="muted">
              {activeFilters > 0 ? t("tables.noRowsFilter") : t("tables.tableEmpty")}
            </div>
          )
        ) : (
          // No cached page for this table yet — the only place a cold load is visible.
          !err && (busy ? <Skeleton lines={8} /> : <div className="muted">{t("tables.noRows")}</div>)
        )}

        {jobsOpen && catalogRelation ? (
          <JobPanel
            connectionId={connection.id}
            relation={catalogRelation}
            onClose={() => setJobsOpen(false)}
          />
        ) : panelOpen ? (
          <aside className="grid-panel">
            {editor && !reviewing && (
              <RowEditor
                key={`${editor.mode}-${selected}`}
                engine={engine}
                table={table}
                mode={editor.mode}
                initial={editor.initial}
                onSubmit={stageWrite}
                onCancel={() => {
                  setEditor(null);
                }}
              />
            )}
            {pendingDelete && (
              <div className="row-editor">
                <div className="panel-head">
                  <strong>{t("tables.deleteRow")}</strong>
                  <button className="btn small icon-only icon-xs" aria-label={t("common.cancel")} onClick={() => setPendingDelete(null)}>
                    <Icon name="close" />
                  </button>
                </div>
                <div className="row-fields">
                  {Object.entries(pendingDelete.key).map(([k, v]) => (
                    <div className="row-field" key={k}>
                      <label>
                        {k}
                        <span className="pk-badge">PK</span>
                      </label>
                      <code>{v == null ? "NULL" : v}</code>
                    </div>
                  ))}
                </div>
                <div className="row-editor-actions ds-action-row ds-control-row">
                  <button className="btn primary" onClick={armDelete}>
                    {t("tables.reviewDelete")}
                  </button>
                  <button className="btn" onClick={() => setPendingDelete(null)}>
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}
            {reviewing && (
              <div className="row-editor staged-change-review">
                <div className="panel-head">
                  <div>
                    <strong>
                      {t("tables.stagedCount", { count: staged.length })}
                    </strong>
                    <div className="muted">
                      {t("tables.stagedAtomicHelp")}
                    </div>
                  </div>
                  <button
                    className="btn small icon-only icon-xs"
                    aria-label={t("common.close")}
                    onClick={() => {
                      setReviewing(false);
                      setStagedProposal(null);
                      setStagedConfirmation("");
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <ol className="staged-change-list">
                  {staged.map((change, index) => (
                    <li key={change.id}>
                      <div>
                        <strong>
                          {change.rationale ||
                            t("tables.stagedChange", { index: index + 1 })}
                        </strong>
                        <code>{change.sql}</code>
                      </div>
                      {!stagedProposal && (
                        <button
                          className="btn small icon-only icon-xs"
                          onClick={() =>
                            setStaged((current) =>
                              current.filter(
                                (candidate) => candidate.id !== change.id,
                              ),
                            )
                          }
                          aria-label={t("common.delete")}
                        >
                          <Icon name="close" />
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
                {stagedProposal?.confirmationPhrase && (
                  <label className="staged-confirmation">
                    <span>
                      {t("approval.confirmationPrompt")}{" "}
                      <code>{stagedProposal.confirmationPhrase}</code>
                    </span>
                    <input
                      value={stagedConfirmation}
                      onChange={(event) =>
                        setStagedConfirmation(event.target.value)
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                )}
                <div className="row-editor-actions ds-action-row ds-control-row">
                  {!stagedProposal ? (
                    <button
                      className="btn primary"
                      disabled={
                        staged.length === 0 ||
                        stagedRunning ||
                        snapshotQuery.isPending
                      }
                      onClick={() => void prepareStagedChanges()}
                    >
                      {stagedRunning
                        ? t("common.loading")
                        : t("tables.reviewAndApply")}
                    </button>
                  ) : (
                    <>
                      <button
                        className="btn primary"
                        disabled={
                          stagedRunning ||
                          (!!stagedProposal.confirmationPhrase &&
                            stagedConfirmation !==
                              stagedProposal.confirmationPhrase)
                        }
                        onClick={() => void approveStagedChanges()}
                      >
                        {stagedRunning
                          ? t("common.saving")
                          : t("approval.approveAndRunWrite")}
                      </button>
                      <button
                        className="btn"
                        disabled={stagedRunning}
                        onClick={() => void rejectStagedChanges()}
                      >
                        {t("approval.reject")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
            {cellSel && !editor && !reviewing && (
              <CellViewer
                value={cellSel.value}
                column={cellSel.column}
                onClose={() => setCellSel(null)}
              />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

// MongoDB read-only data view: pagination and totals only (documentRowsQuery +
// documentCountQuery), no filters/sort/insert/edit/delete/duplicate/RowEditor — none of
// those are SQL concepts here. Columns are the union of returned documents' top-level keys
// (_id first), falling back to the catalog's sampled field names when the page has no documents.
function MongoTableData({
  connection,
  table,
}: {
  connection: ConnectionProfile;
  table: CatalogTable;
}) {
  const { t } = useI18n();
  const pageSize = PAGE;
  const key = tableKey(table);

  const [page, setPage] = useState(0);
  const [viewKey, setViewKey] = useState(key);
  if (viewKey !== key) {
    setViewKey(key);
    setPage(0);
  }

  const rowsQuery = useQuery({
    ...documentRowsQuery({
      connectionId: connection.id,
      collection: table.name,
      pageSize,
      page,
    }),
    placeholderData: keepPreviousData,
  });
  // Cached per collection (not per page), so paging never re-runs count_documents.
  const countQuery = useQuery(documentCountQuery(connection.id, table.name));

  const docPage = rowsQuery.data ?? null;
  const total = countQuery.data ?? null;
  const busy = rowsQuery.isFetching;
  const err = rowsQuery.error ? errMessage(rowsQuery.error) : null;

  const fallbackColumns = useMemo(() => table.columns.map((c) => c.name), [table.columns]);
  const grid = useMemo(
    () => documentsToGrid(docPage?.documents ?? [], fallbackColumns),
    [docPage, fallbackColumns],
  );
  const result: QueryResult = {
    columns: grid.columns,
    rows: grid.rows,
    rowCount: grid.rows.length,
    truncated: docPage?.truncated ?? false,
    durationMs: docPage?.durationMs ?? 0,
  };

  const rows = result.rows.length;
  const from = rows === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + rows;

  return (
    <div className="table-data">
      <div className="table-data-context">
        <div className="table-data-identity">
          <Icon name={table.kind === "view" ? "view" : "collection"} />
          <strong>{tableLabel(connection.engine, table)}</strong>
          <span className="ds-context-badge">
            {table.kind === "view" ? t("schema.view") : t("tables.sourceCollection")}
          </span>
        </div>
        <div className="ds-meta-row">
          <span>LIMIT {pageSize.toLocaleString()}</span>
          {docPage && (
            <>
              <span className="ds-meta-dot" />
              <span>
                {total != null
                  ? t("tables.rowRangeTotal", { from, to, total: total.toLocaleString() })
                  : t("tables.rowRange", { from, to })}
                {docPage.truncated ? " (truncated)" : ""}
              </span>
              <span className="ds-meta-dot" />
              <span>{docPage.durationMs} ms</span>
            </>
          )}
        </div>
      </div>
      <div className="grid-toolbar ds-data-toolbar ds-control-row">
        <span className="ds-toolbar-spacer" />
        <Pager
          page={page}
          pageSize={pageSize}
          total={total}
          rows={rows}
          busy={busy}
          onPage={setPage}
          onRefresh={() => {
            void rowsQuery.refetch();
            void countQuery.refetch();
          }}
        />
      </div>

      {err && <div className="error">{err}</div>}

      <div className={busy && docPage ? "table-data-body busy" : "table-data-body"}>
        {docPage ? (
          <>
            <DataGrid
              result={result}
              startIndex={page * pageSize}
              columnMeta={Object.fromEntries(
                table.columns.map((column) => [
                  column.name,
                  { dataType: column.dataType, pk: column.pk },
                ]),
              )}
            />
            {rows === 0 && !busy && <div className="muted">{t("tables.tableEmpty")}</div>}
          </>
        ) : (
          !err && (busy ? <Skeleton lines={8} /> : <div className="muted">{t("tables.noRows")}</div>)
        )}
      </div>
    </div>
  );
}
