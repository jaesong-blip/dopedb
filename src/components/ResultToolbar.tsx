// Compact export/copy controls for any result grid. Workbench surfaces use the
// DopeDB command grammar of Copy + one CSV format menu; inline metadata keeps
// the explicit text actions. Every action operates on the full result rows.
import {
  iterateSqlStreamRows,
  type SqlStreamRowSource,
} from "../features/queries/domain";
import {
  copyTsvTerminalSnapshot,
  downloadCsv,
  downloadCsvTerminalSnapshot,
  downloadJson,
  downloadJsonTerminalSnapshot,
  toTsv,
} from "../lib/export";
import { useI18n } from "../lib/i18n";
import { WorkbenchButton } from "../design-system/components/Workbench";
import { Icon } from "./Icon";
import ToolbarMenu, { ToolbarMenuItem } from "./ToolbarMenu";
import { useToast } from "./Toast";

export default function ResultToolbar({
  columns,
  rows,
  rowSource,
  filenameBase,
  scopeLabel,
  partial,
  presentation = "inline",
}: {
  columns: string[];
  rows?: unknown[][];
  rowSource?: SqlStreamRowSource;
  filenameBase: string;
  // Optional on-surface scope for page-limited exports (e.g. "page"). Default keeps
  // the bare "CSV"/"JSON" labels so existing callers (Sql, Agent) are unchanged.
  scopeLabel?: string;
  /** Running streams are partial snapshots and cannot be exported as complete. */
  partial?: boolean;
  /** Dense Services toolbar presentation; the default remains inline metadata. */
  presentation?: "inline" | "workbench";
}) {
  const { t } = useI18n();
  const toast = useToast();
  const count = rowSource?.rowCount ?? rows?.length ?? 0;
  const disabled = partial === true;
  const source = () =>
    rowSource ? iterateSqlStreamRows(rowSource) : (rows ?? []);
  const exportCsv = () => {
    if (rowSource) {
      void downloadCsvTerminalSnapshot(filenameBase, columns, source()).catch(
        () => toast(t("results.copyFailed"), "error"),
      );
      return;
    }
    downloadCsv(filenameBase, columns, rows ?? []);
  };
  const exportJson = () => {
    if (rowSource) {
      void downloadJsonTerminalSnapshot(filenameBase, columns, source()).catch(
        () => toast(t("results.copyFailed"), "error"),
      );
      return;
    }
    downloadJson(filenameBase, columns, rows ?? []);
  };
  return (
    <span
      data-presentation={presentation}
      className="tw:inline-flex tw:items-center tw:gap-1 tw:align-middle tw:data-[presentation=inline]:ml-2 tw:data-[presentation=workbench]:ml-auto"
    >
      <WorkbenchButton
        iconOnly={presentation === "workbench"}
        size={presentation === "workbench" ? "xs" : "md"}
        title={t("results.copyTitle")}
        aria-label={t("results.copyTitle")}
        onClick={() =>
          (rowSource
            ? copyTsvTerminalSnapshot(columns, source())
            : navigator.clipboard.writeText(toTsv(columns, rows ?? []))
          )
            .then(() => toast(t("results.copyRows", { count })))
            .catch(() => toast(t("results.copyFailed"), "error"))
        }
        disabled={disabled}
      >
        {presentation === "workbench" ? (
          <Icon name="copy" />
        ) : (
          t("results.copy")
        )}
      </WorkbenchButton>
      {presentation === "workbench" ? (
        <ToolbarMenu
          label={t("results.downloadCsvTitle")}
          disabled={disabled}
          trigger={
            <>
              CSV
              <Icon name="chevronDown" />
            </>
          }
        >
          <ToolbarMenuItem icon="download" onClick={exportCsv}>
            {t("results.downloadCsvTitle")}
          </ToolbarMenuItem>
          <ToolbarMenuItem icon="download" onClick={exportJson}>
            {t("results.downloadJsonTitle")}
          </ToolbarMenuItem>
        </ToolbarMenu>
      ) : (
        <>
          <WorkbenchButton
            title={t("results.downloadCsvTitle")}
            disabled={disabled}
            onClick={exportCsv}
          >
            {scopeLabel
              ? t("results.exportCsv", { scope: scopeLabel })
              : "CSV"}
          </WorkbenchButton>
          <WorkbenchButton
            title={t("results.downloadJsonTitle")}
            disabled={disabled}
            onClick={exportJson}
          >
            {scopeLabel
              ? t("results.exportJson", { scope: scopeLabel })
              : "JSON"}
          </WorkbenchButton>
        </>
      )}
      {disabled && (
        <span className="tw:text-muted-foreground">
          {t("results.partialExportUnavailable")}
        </span>
      )}
    </span>
  );
}
