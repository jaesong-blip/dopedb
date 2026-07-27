import type { ReactNode } from "react";

import { Icon } from "../../components/Icon";
import { useI18n } from "../../lib/i18n";

export default function Pager({
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
  const lastPage =
    total != null ? Math.max(0, Math.ceil(total / pageSize) - 1) : null;
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
