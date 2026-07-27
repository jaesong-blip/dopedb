import { Icon } from "../../components/Icon";
import ToolbarMenu from "../../components/ToolbarMenu";
import type { CatalogTable, QueryResult, SafetySettings } from "../../ipc/types";
import { downloadCsv, downloadJson, stamp } from "../../lib/export";
import { useI18n } from "../../lib/i18n";
import type { GridSort } from "../../lib/sqlBuild";
import Pager from "./Pager";

type Props = {
  table: CatalogTable;
  safety: SafetySettings;
  result: QueryResult | null;
  canEdit: boolean;
  noEditTitle: string;
  selected: number | null;
  stagedCount: number;
  activeFilters: number;
  sort: GridSort | null;
  page: number;
  pageSize: number;
  total: number | null;
  rows: number;
  busy: boolean;
  jobsOpen: boolean;
  catalogAvailable: boolean;
  structureOpen: boolean;
  onOpenEdit: (mode: "insert" | "edit" | "duplicate") => void;
  onDelete: () => void;
  onReviewStaged: () => void;
  onDiscardStaged: () => void;
  onClearFilters: () => void;
  onPage: (page: number) => void;
  onRefresh: () => void;
  onToggleJobs: () => void;
  onToggleStructure: () => void;
  onCopyRow: (json: boolean) => void;
};

export default function TableToolbar(props: Props) {
  const { t } = useI18n();
  const {
    table,
    safety,
    result,
    canEdit,
    noEditTitle,
    selected,
    stagedCount,
    activeFilters,
    sort,
    page,
    pageSize,
    total,
    rows,
    busy,
    jobsOpen,
    catalogAvailable,
    structureOpen,
  } = props;

  return (
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
            onClick={() => props.onOpenEdit("insert")}
          >
            <Icon name="plus" />
            <span className="table-action-label">{t("tables.insert")}</span>
          </button>
          <button
            className="btn small ghost table-row-action"
            disabled={!canEdit || selected == null}
            title={canEdit ? t("tables.edit") : noEditTitle}
            aria-label={t("tables.edit")}
            onClick={() => props.onOpenEdit("edit")}
          >
            <Icon name="pencil" />
            <span className="table-action-label">{t("tables.edit")}</span>
          </button>
          <button
            className="btn small danger-ghost table-row-action"
            disabled={!canEdit || selected == null}
            title={canEdit ? t("tables.delete") : noEditTitle}
            aria-label={t("tables.delete")}
            onClick={props.onDelete}
          >
            <Icon name="trash" />
            <span className="table-action-label">{t("tables.delete")}</span>
          </button>
          {stagedCount > 0 && (
            <>
              <button
                className="btn small active"
                onClick={props.onReviewStaged}
                title={t("tables.reviewStaged")}
              >
                <Icon name="check" />
                {t("tables.stagedCount", { count: stagedCount })}
              </button>
              <button
                className="btn small icon-only"
                onClick={props.onDiscardStaged}
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
              ? t(
                  activeFilters > 1
                    ? "tables.activeFiltersPlural"
                    : "tables.activeFilters",
                  { count: activeFilters },
                )
              : t("tables.noFilters")}
          </span>
          <span
            className={sort ? "table-state active" : "table-state"}
            title={t("tables.sortState")}
          >
            <Icon name="sort" />
            {sort
              ? `${sort.col} ${sort.dir.toUpperCase()}`
              : t("tables.unsorted")}
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
            <button className="btn small" onClick={props.onClearFilters}>
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
        onPage={props.onPage}
        onRefresh={props.onRefresh}
      >
        <button
          className={`btn small icon-only table-secondary-action${jobsOpen ? " active" : ""}`}
          disabled={!catalogAvailable}
          aria-expanded={jobsOpen}
          title={
            catalogAvailable ? t("jobs.open") : t("tables.catalogRequired")
          }
          aria-label={t("jobs.open")}
          onClick={props.onToggleJobs}
        >
          <Icon name="download" />
        </button>
        <button
          className={`btn small icon-only table-secondary-action${structureOpen ? " active" : ""}`}
          aria-expanded={structureOpen}
          title={t("tables.structureTitle")}
          aria-label={t("tables.structureTitle")}
          onClick={props.onToggleStructure}
        >
          <Icon name="columns" />
        </button>
        <ToolbarMenu label={t("tables.more")} icon="moreVertical">
          <button
            type="button"
            role="menuitem"
            className="ds-menu-item"
            disabled={busy}
            onClick={props.onRefresh}
          >
            <Icon name="refresh" />
            {t("common.refresh")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ds-menu-item"
            disabled={!catalogAvailable}
            onClick={props.onToggleJobs}
          >
            <Icon name="download" />
            {t("jobs.open")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ds-menu-item"
            onClick={props.onToggleStructure}
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
            onClick={() => props.onOpenEdit("duplicate")}
          >
            <Icon name="copy" />
            {t("tables.duplicate")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ds-menu-item"
            disabled={selected == null}
            onClick={() => props.onCopyRow(false)}
          >
            <Icon name="copy" />
            {t("tables.copyTsv")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ds-menu-item"
            disabled={selected == null}
            onClick={() => props.onCopyRow(true)}
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
              result &&
              downloadCsv(
                `${table.name}-page${page + 1}-${stamp()}`,
                result.columns,
                result.rows,
              )
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
              result &&
              downloadJson(
                `${table.name}-page${page + 1}-${stamp()}`,
                result.columns,
                result.rows,
              )
            }
          >
            <Icon name="download" />
            {t("tables.exportJson")}
          </button>
        </ToolbarMenu>
      </Pager>
    </div>
  );
}
