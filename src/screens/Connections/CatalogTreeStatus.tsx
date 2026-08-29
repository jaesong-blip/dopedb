// Renders the database tree's mutually exclusive access, load, and empty states.
import type { ConnectionAccessIssue } from "../../features/connections/domain";
import { LoadingLabel } from "../../design-system/components/Status";
import { useI18n } from "../../lib/i18n";

interface CatalogTreeStatusProps {
  accessIssue?: ConnectionAccessIssue;
  error?: string;
  detailError?: string;
  catalogLoaded: boolean;
  empty: boolean;
  normalizedFilter: string;
  databaseTreeKey: string;
  treeLevel: number;
  onResolveAccess?: () => void;
  onRetryOverview: () => void;
  onRequestDetails: () => void;
}

export function CatalogTreeStatus({
  accessIssue,
  error,
  detailError,
  catalogLoaded,
  empty,
  normalizedFilter,
  databaseTreeKey,
  treeLevel,
  onResolveAccess,
  onRetryOverview,
  onRequestDetails,
}: CatalogTreeStatusProps) {
  const { t } = useI18n();
  return (
    <>
      {accessIssue ? (
        <div className="tw:grid tw:gap-1 tw:px-2 tw:py-2 tw:text-sm">
          <strong className="tw:text-foreground">
            {accessIssue === "grant"
              ? t("workspace.connectionUseRequired")
              : t("workspace.credentialsRequiredTitle")}
          </strong>
          <span className="tw:text-xs tw:leading-body tw:text-muted-foreground">
            {accessIssue === "grant"
              ? t("workspace.connectionUseRequiredBody")
              : t("workspace.credentialsRequiredBody")}
          </span>
          {accessIssue === "credentials" && onResolveAccess ? (
            <button
              type="button"
              className="tw:mt-1 tw:w-fit tw:cursor-pointer tw:rounded-xs tw:border tw:border-border-subtle tw:bg-card tw:px-2 tw:py-1 tw:font-sans tw:text-xs tw:text-foreground tw:hover:border-ring"
              onClick={onResolveAccess}
              role="treeitem"
              aria-level={treeLevel + 1}
              data-explorer-tree-item
              data-explorer-tree-key={`${databaseTreeKey}:resolve-access`}
              data-explorer-tree-parent-key={databaseTreeKey}
              data-tree-primary-action
              tabIndex={-1}
            >
              {t("workspace.bindCredentialsShort")}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="tw:flex tw:items-start tw:gap-2 tw:px-2 tw:py-1 tw:text-sm tw:text-danger">
          <span className="tw:min-w-0 tw:flex-1 tw:wrap-break-word">{error}</span>
          <button
            type="button"
            className="tw:shrink-0 tw:cursor-pointer tw:rounded-xs tw:border tw:border-border-subtle tw:bg-card tw:px-1.5 tw:py-px tw:font-sans tw:text-2xs tw:text-foreground tw:hover:border-ring"
            onClick={onRetryOverview}
            role="treeitem"
            aria-level={treeLevel + 1}
            data-explorer-tree-item
            data-explorer-tree-key={`${databaseTreeKey}:retry-overview`}
            data-explorer-tree-parent-key={databaseTreeKey}
            data-tree-primary-action
            tabIndex={-1}
          >
            {t("common.refresh")}
          </button>
        </div>
      ) : null}
      {detailError ? (
        <div className="tw:flex tw:items-start tw:gap-2 tw:px-2 tw:py-1 tw:text-sm tw:text-muted-foreground">
          <span className="tw:min-w-0 tw:flex-1 tw:wrap-break-word">
            {detailError}
          </span>
          <button
            type="button"
            className="tw:shrink-0 tw:cursor-pointer tw:rounded-xs tw:border tw:border-border-subtle tw:bg-card tw:px-1.5 tw:py-px tw:font-sans tw:text-2xs tw:text-foreground tw:hover:border-ring"
            onClick={onRequestDetails}
            role="treeitem"
            aria-level={treeLevel + 1}
            data-explorer-tree-item
            data-explorer-tree-key={`${databaseTreeKey}:retry-details`}
            data-explorer-tree-parent-key={databaseTreeKey}
            data-tree-primary-action
            tabIndex={-1}
          >
            {t("common.refresh")}
          </button>
        </div>
      ) : null}
      {!catalogLoaded && !error && !accessIssue ? (
        <div className="tw:px-2 tw:py-1 tw:text-sm">
          <LoadingLabel>{t("connections.loadingSchema")}</LoadingLabel>
        </div>
      ) : null}
      {catalogLoaded && empty ? (
        <div className="tw:px-2 tw:py-1 tw:text-sm tw:text-muted-foreground">
          {normalizedFilter
            ? t("connections.noTablesMatch", { filter: normalizedFilter })
            : t("connections.noObjects")}
        </div>
      ) : null}
    </>
  );
}
