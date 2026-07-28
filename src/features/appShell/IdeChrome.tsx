// DopeDB 2026.1 desktop chrome: project context and real tool-window launchers share
// one quiet title toolbar. macOS owns its native File/Edit/View menus, so the
// WebView must not draw a second application menu inside the window.
import type { ReactNode } from "react";
import type { CatalogTable } from "../../ipc/types";
import type { ConnectionProfile } from "../connections/domain";
import { Icon } from "../../components/Icon";
import { StatusDot } from "../../design-system/components/Status";
import { useI18n } from "../../lib/i18n";
import { tableLabel } from "../../lib/tableRef";
import type { AppArea } from "./WorkbenchRail";

const IS_MACOS =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

export function IdeTopBar({
  area,
  selected,
  supportsSql,
  databaseExplorerOpen,
  servicesOpen,
  showTerminalDock,
  account,
  onNewQuery,
  onArea,
  onToggleDatabaseExplorer,
  onToggleServices,
  onOpenTerminal,
  onSettings,
}: {
  area: AppArea;
  selected: ConnectionProfile | null;
  supportsSql: boolean;
  databaseExplorerOpen: boolean;
  servicesOpen: boolean;
  showTerminalDock: boolean;
  account: ReactNode;
  onNewQuery: () => void;
  onArea: (area: AppArea) => void;
  onToggleDatabaseExplorer: () => void;
  onToggleServices: () => void;
  onOpenTerminal: () => void;
  onSettings: () => void;
}) {
  const { t } = useI18n();
  const queryDisabled = !selected || !supportsSql;
  const focusExplorer = () =>
    document
      .querySelector<HTMLInputElement>(".table-filter, .ide-explorer-search")
      ?.focus();

  return (
    <header
      className="ide-topbar tw:relative tw:z-[var(--ds-z-sticky)] tw:flex tw:h-full tw:min-w-0 tw:select-none tw:items-center tw:gap-1 tw:border-b tw:border-border-subtle tw:bg-card tw:px-2 tw:text-muted-foreground"
      data-tauri-drag-region="deep"
    >
      <div
        className={
          IS_MACOS
            ? "tw:block tw:w-[68px] tw:shrink-0"
            : "tw:hidden tw:shrink-0"
        }
        aria-hidden="true"
      />
      <button
        type="button"
        className="tw:inline-flex tw:h-control-md tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-2 tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-2 tw:font-sans tw:text-sm tw:font-semibold tw:text-foreground tw:hover:bg-muted"
        onClick={() => onArea("workspace")}
        aria-label={t("ide.project")}
      >
        <span className="tw:grid tw:size-5 tw:shrink-0 tw:place-items-center tw:rounded-xs tw:bg-secondary tw:font-mono tw:text-xs tw:font-bold tw:text-foreground">
          D
        </span>
        <span className="tw:max-w-[170px] tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
          {t("ide.project")}
        </span>
        <Icon
          name="chevronDown"
          className="tw:text-xs tw:text-muted-foreground"
        />
      </button>

      <div
        className="tw:absolute tw:left-1/2 tw:flex tw:-translate-x-1/2 tw:items-center tw:gap-1 tw:[&_.btn]:[--ds-icon-button-size:28px]"
        role="toolbar"
        aria-label={t("ide.mainToolbar")}
      >
        <button
          type="button"
          className="btn small icon-only"
          onClick={() => {
            if (area === "workspace") onToggleDatabaseExplorer();
            else onArea("workspace");
          }}
          title={t("ide.action.databaseExplorer")}
          aria-label={t("ide.action.databaseExplorer")}
          aria-pressed={area === "workspace" && databaseExplorerOpen}
        >
          <Icon name="database" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          onClick={onToggleServices}
          title={t("services.title")}
          aria-label={t("services.title")}
          aria-pressed={servicesOpen}
        >
          <Icon name="list" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          onClick={() => onArea("dashboard")}
          title={t("tabs.dashboard")}
          aria-label={t("tabs.dashboard")}
          aria-pressed={area === "dashboard" && databaseExplorerOpen}
        >
          <Icon name="dashboard" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          disabled={queryDisabled}
          onClick={onNewQuery}
          title={t("ide.action.newQuery")}
          aria-label={t("ide.action.newQuery")}
        >
          <Icon name="play" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          disabled={!selected}
          onClick={onOpenTerminal}
          title={t("terminal.title")}
          aria-label={t("terminal.title")}
          aria-pressed={showTerminalDock}
        >
          <Icon name="terminal" />
        </button>
      </div>

      <div className="tw:ml-auto tw:flex tw:shrink-0 tw:items-center tw:gap-1 tw:[&_.btn]:[--ds-icon-button-size:28px]">
        <div className="tw:size-7 tw:shrink-0">{account}</div>
        <button
          type="button"
          className="btn small icon-only"
          onClick={focusExplorer}
          title={t("ide.action.findObject")}
          aria-label={t("ide.action.findObject")}
        >
          <Icon name="search" />
        </button>
        <button
          type="button"
          className="btn small icon-only"
          onClick={onSettings}
          title={t("common.settings")}
          aria-label={t("common.settings")}
        >
          <Icon name="gear" />
        </button>
      </div>
    </header>
  );
}

export function IdeStatusBar({
  selected,
  selectedTable,
  settingsOpen,
  connectionCount,
  onSettings,
}: {
  selected: ConnectionProfile | null;
  selectedTable: CatalogTable | null;
  settingsOpen: boolean;
  connectionCount: number;
  onSettings: () => void;
}) {
  const { t } = useI18n();

  return (
    <footer
      className="ide-statusbar tw:z-[var(--ds-z-sticky)] tw:flex tw:min-w-0 tw:items-center tw:border-t tw:border-border-subtle tw:bg-card tw:text-xs tw:leading-none tw:text-muted-foreground"
      aria-label={t("ide.statusBar")}
    >
      <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:px-2">
        <span className="tw:font-semibold tw:text-foreground">DopeDB</span>
        <span>/</span>
        <span>{selected?.name || t("ide.noDataSource")}</span>
        {selectedTable ? (
          <>
            <span>/</span>
            <span>{tableLabel(selected?.engine ?? "postgres", selectedTable)}</span>
          </>
        ) : null}
      </div>
      <div className="tw:flex-1" />
      <span className="tw:inline-flex tw:h-[23px] tw:shrink-0 tw:items-center tw:gap-1 tw:whitespace-nowrap tw:border-0 tw:border-l tw:border-border-subtle tw:bg-transparent tw:px-2 tw:font-sans tw:text-inherit">
        <StatusDot tone={selected ? "success" : "neutral"} />
        {selected ? t("ide.connected") : t("ide.disconnected")}
      </span>
      {selected ? (
        <>
          <span className="tw:inline-flex tw:h-[23px] tw:shrink-0 tw:items-center tw:gap-1 tw:whitespace-nowrap tw:border-0 tw:border-l tw:border-border-subtle tw:bg-transparent tw:px-2 tw:font-sans tw:text-inherit">
            {selected.engine}
          </span>
          <span className="tw:inline-flex tw:h-[23px] tw:shrink-0 tw:items-center tw:gap-1 tw:whitespace-nowrap tw:border-0 tw:border-l tw:border-border-subtle tw:bg-transparent tw:px-2 tw:font-sans tw:text-inherit">
            {selected.database}
          </span>
          <span className="tw:inline-flex tw:h-[23px] tw:shrink-0 tw:items-center tw:gap-1 tw:whitespace-nowrap tw:border-0 tw:border-l tw:border-border-subtle tw:bg-transparent tw:px-2 tw:font-sans tw:text-inherit">
            {selected.readonlyDefault
              ? t("ide.readOnly")
              : t("ide.writeEnabled")}
          </span>
        </>
      ) : (
        <span className="tw:inline-flex tw:h-[23px] tw:shrink-0 tw:items-center tw:gap-1 tw:whitespace-nowrap tw:border-0 tw:border-l tw:border-border-subtle tw:bg-transparent tw:px-2 tw:font-sans tw:text-inherit">
          {t("ide.dataSourceCount", { count: connectionCount })}
        </span>
      )}
      <span className="tw:inline-flex tw:h-[23px] tw:shrink-0 tw:items-center tw:gap-1 tw:whitespace-nowrap tw:border-0 tw:border-l tw:border-border-subtle tw:bg-transparent tw:px-2 tw:font-sans tw:text-inherit">
        UTF-8
      </span>
      <button
        type="button"
        data-active={settingsOpen}
        className="tw:inline-flex tw:h-[23px] tw:w-7 tw:shrink-0 tw:cursor-pointer tw:items-center tw:justify-center tw:border-0 tw:border-l tw:border-border-subtle tw:bg-transparent tw:p-0 tw:font-sans tw:text-inherit tw:data-[active=true]:bg-muted tw:data-[active=true]:text-foreground tw:hover:bg-muted tw:hover:text-foreground"
        onClick={onSettings}
        aria-label={t("common.settings")}
        title={t("common.settings")}
      >
        <Icon name="gear" />
      </button>
    </footer>
  );
}
