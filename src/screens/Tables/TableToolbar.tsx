import { Icon } from "../../components/Icon";
import ToolbarMenu, {
  ToolbarMenuItem,
} from "../../components/ToolbarMenu";
import {
  WorkbenchDivider,
  WorkbenchToolbar,
} from "../../design-system/components/Workbench";
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
    <WorkbenchToolbar label={t("tables.querySurface")}>
      <div className="table-toolbar-scroll scrollbar-sleek tw:flex tw:min-w-0 tw:flex-1 tw:items-center tw:gap-1 tw:overflow-x-auto tw:overflow-y-hidden tw:overscroll-x-contain">
        <div className="tw:flex tw:shrink-0 tw:items-center tw:gap-1">
          <button
            className="btn small ghost tw:shrink-0 tw:@max-[760px]:size-control-md tw:@max-[760px]:px-0"
            disabled={!canEdit}
            title={canEdit ? t("tables.insert") : noEditTitle}
            aria-label={t("tables.insert")}
            onClick={() => props.onOpenEdit("insert")}
          >
            <Icon name="plus" />
            <span className="tw:@max-[760px]:hidden">{t("tables.insert")}</span>
          </button>
          <button
            className="btn small ghost tw:shrink-0 tw:@max-[760px]:size-control-md tw:@max-[760px]:px-0"
            disabled={!canEdit || selected == null}
            title={canEdit ? t("tables.edit") : noEditTitle}
            aria-label={t("tables.edit")}
            onClick={() => props.onOpenEdit("edit")}
          >
            <Icon name="pencil" />
            <span className="tw:@max-[760px]:hidden">{t("tables.edit")}</span>
          </button>
          <button
            className="btn small danger-ghost tw:shrink-0 tw:@max-[760px]:size-control-md tw:@max-[760px]:px-0"
            disabled={!canEdit || selected == null}
            title={canEdit ? t("tables.delete") : noEditTitle}
            aria-label={t("tables.delete")}
            onClick={props.onDelete}
          >
            <Icon name="trash" />
            <span className="tw:@max-[760px]:hidden">{t("tables.delete")}</span>
          </button>
          {stagedCount > 0 ? (
            <>
              <button
                className="btn small tw:bg-selection tw:text-selection-foreground"
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
          ) : null}
        </div>

        <WorkbenchDivider />

        <div
          className="tw:flex tw:min-w-0 tw:items-center tw:gap-3 tw:text-sm tw:text-muted-foreground tw:@max-[760px]:hidden"
          aria-label={t("tables.querySurface")}
        >
          <span
            data-active={activeFilters > 0}
            className="tw:inline-flex tw:min-w-0 tw:items-center tw:gap-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:data-[active=true]:text-primary"
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
            data-active={Boolean(sort)}
            className="tw:inline-flex tw:min-w-0 tw:items-center tw:gap-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:data-[active=true]:text-primary"
            title={t("tables.sortState")}
          >
            <Icon name="sort" />
            {sort
              ? `${sort.col} ${sort.dir.toUpperCase()}`
              : t("tables.unsorted")}
          </span>
          <span
            data-risk={safety.allowWrites}
            className="tw:inline-flex tw:min-w-0 tw:items-center tw:gap-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:data-[risk=true]:text-warning"
            title={t("tables.writePolicy")}
          >
            <Icon name={safety.allowWrites ? "pencil" : "circleSlash"} />
            {safety.allowWrites
              ? t("tables.writePolicyWrites")
              : t("tables.writePolicyReadonly")}
          </span>
          {activeFilters > 0 ? (
            <button className="btn small" onClick={props.onClearFilters}>
              {t("tables.clear")}
            </button>
          ) : null}
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
          className="btn small icon-only tw:@max-[760px]:hidden tw:aria-expanded:bg-selection tw:aria-expanded:text-selection-foreground"
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
          className="btn small icon-only tw:@max-[760px]:hidden tw:aria-expanded:bg-selection tw:aria-expanded:text-selection-foreground"
          aria-expanded={structureOpen}
          title={t("tables.structureTitle")}
          aria-label={t("tables.structureTitle")}
          onClick={props.onToggleStructure}
        >
          <Icon name="columns" />
        </button>
        <ToolbarMenu label={t("tables.more")} icon="moreVertical">
          <ToolbarMenuItem
            icon="refresh"
            disabled={busy}
            onClick={props.onRefresh}
          >
            {t("common.refresh")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon="download"
            disabled={!catalogAvailable}
            onClick={props.onToggleJobs}
          >
            {t("jobs.open")}
          </ToolbarMenuItem>
          <ToolbarMenuItem icon="columns" onClick={props.onToggleStructure}>
            {t("tables.structureTitle")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon="copy"
            disabled={!canEdit || selected == null}
            title={canEdit ? undefined : noEditTitle}
            onClick={() => props.onOpenEdit("duplicate")}
          >
            {t("tables.duplicate")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon="copy"
            disabled={selected == null}
            onClick={() => props.onCopyRow(false)}
          >
            {t("tables.copyTsv")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon="copy"
            disabled={selected == null}
            onClick={() => props.onCopyRow(true)}
          >
            {t("tables.copyJson")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon="download"
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
            {t("tables.exportCsv")}
          </ToolbarMenuItem>
          <ToolbarMenuItem
            icon="download"
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
            {t("tables.exportJson")}
          </ToolbarMenuItem>
        </ToolbarMenu>
      </Pager>
    </WorkbenchToolbar>
  );
}
