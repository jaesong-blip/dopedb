// Compact export/copy controls for any result grid: Copy (TSV) · CSV · JSON.
// Always operate on the FULL result rows, not a display-sliced subset.
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
import { useToast } from "./Toast";

export default function ResultToolbar({
  columns,
  rows,
  rowSource,
  filenameBase,
  scopeLabel,
  partial,
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
}) {
  const { t } = useI18n();
  const toast = useToast();
  const count = rowSource?.rowCount ?? rows?.length ?? 0;
  const disabled = partial === true;
  const source = () =>
    rowSource ? iterateSqlStreamRows(rowSource) : (rows ?? []);
  return (
    <span className="tw:ml-2 tw:inline-flex tw:items-center tw:gap-2 tw:align-middle">
      <button
        className="btn small ghost"
        title={t("results.copyTitle")}
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
        {t("results.copy")}
      </button>
      <button
        className="btn small ghost"
        title={t("results.downloadCsvTitle")}
        disabled={disabled}
        onClick={() => {
          if (rowSource) {
            void downloadCsvTerminalSnapshot(filenameBase, columns, source()).catch(() =>
              toast(t("results.copyFailed"), "error"),
            );
          } else downloadCsv(filenameBase, columns, rows ?? []);
        }}
      >
        {scopeLabel ? t("results.exportCsv", { scope: scopeLabel }) : "CSV"}
      </button>
      <button
        className="btn small ghost"
        title={t("results.downloadJsonTitle")}
        disabled={disabled}
        onClick={() => {
          if (rowSource) {
            void downloadJsonTerminalSnapshot(filenameBase, columns, source()).catch(() =>
              toast(t("results.copyFailed"), "error"),
            );
          } else downloadJson(filenameBase, columns, rows ?? []);
        }}
      >
        {scopeLabel ? t("results.exportJson", { scope: scopeLabel }) : "JSON"}
      </button>
      {disabled && (
        <span className="tw:text-muted-foreground">
          {t("results.partialExportUnavailable")}
        </span>
      )}
    </span>
  );
}
