// DopeDB-inspired desktop chrome. It turns existing DopeDB actions into a
// persistent IDE menu/toolbar/status surface without duplicating their state or
// bypassing feature-level commands.
import type { CatalogTable } from "../../ipc/types";
import type { ConnectionProfile } from "../connections/domain";
import { Icon, type IconName } from "../../components/Icon";
import { StatusDot } from "../../design-system/components/Status";
import { useI18n, type I18nKey } from "../../lib/i18n";
import { tableLabel } from "../../lib/tableRef";
import type { AppArea } from "./WorkbenchRail";

type MenuAction = {
  label: I18nKey;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
};

const IS_MACOS =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

function IdeMenu({
  label,
  actions,
}: {
  label: I18nKey;
  actions: MenuAction[];
}) {
  const { t } = useI18n();

  return (
    <details
      role="none"
      className="tw:relative tw:[&[open]>summary]:bg-muted tw:[&[open]>summary]:text-foreground"
    >
      <summary
        role="menuitem"
        aria-haspopup="menu"
        className="tw:flex tw:h-7 tw:cursor-default tw:list-none tw:items-center tw:rounded-xs tw:px-2 tw:text-sm tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground tw:[&::-webkit-details-marker]:hidden"
      >
        {t(label)}
      </summary>
      <div
        className="tw:absolute tw:top-[calc(100%+var(--ds-space-1))] tw:left-0 tw:z-[var(--ds-z-popover)] tw:grid tw:min-w-[238px] tw:gap-[2px] tw:rounded-sm tw:border tw:border-border-strong tw:bg-popover tw:p-1 tw:shadow-popover"
        role="menu"
        aria-label={t(label)}
      >
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="tw:grid tw:min-h-control-sm tw:cursor-pointer tw:grid-cols-[18px_minmax(0,1fr)_auto] tw:items-center tw:gap-2 tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-2 tw:font-sans tw:text-sm tw:text-foreground tw:disabled:cursor-default tw:disabled:opacity-40 tw:not-disabled:hover:bg-selection tw:not-disabled:hover:text-selection-foreground tw:focus-visible:bg-selection tw:focus-visible:text-selection-foreground tw:focus-visible:outline-none"
            role="menuitem"
            disabled={action.disabled}
            onClick={(event) => {
              action.onSelect();
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            {action.icon ? (
              <Icon
                name={action.icon}
                className="tw:text-[length:var(--ds-icon-sm)]"
              />
            ) : (
              <span aria-hidden="true" />
            )}
            <span>{t(action.label)}</span>
            {action.shortcut ? (
              <kbd className="tw:font-sans tw:text-xs tw:font-normal tw:text-current tw:opacity-70">
                {action.shortcut}
              </kbd>
            ) : null}
          </button>
        ))}
      </div>
    </details>
  );
}

export function IdeTopBar({
  area,
  selected,
  supportsSql,
  showTerminalDock,
  onNewConnection,
  onNewQuery,
  onOpenActivity,
  onArea,
  onOpenTerminal,
  onSettings,
}: {
  area: AppArea;
  selected: ConnectionProfile | null;
  supportsSql: boolean;
  showTerminalDock: boolean;
  onNewConnection: () => void;
  onNewQuery: () => void;
  onOpenActivity: () => void;
  onArea: (area: AppArea) => void;
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
        role="menubar"
        className="tw:flex tw:min-w-0 tw:items-center tw:gap-[2px]"
        aria-label={t("ide.mainMenu")}
      >
        <IdeMenu
          label="ide.menu.file"
          actions={[
            {
              label: "ide.action.newDataSource",
              icon: "database",
              shortcut: "⌘N",
              onSelect: onNewConnection,
            },
            {
              label: "ide.action.newQuery",
              icon: "play",
              shortcut: "⌘⇧N",
              disabled: queryDisabled,
              onSelect: onNewQuery,
            },
          ]}
        />
        <IdeMenu
          label="ide.menu.edit"
          actions={[
            {
              label: "ide.action.findObject",
              icon: "search",
              shortcut: "⇧⇧",
              onSelect: focusExplorer,
            },
            {
              label: "common.settings",
              icon: "gear",
              shortcut: "⌘,",
              onSelect: onSettings,
            },
          ]}
        />
        <IdeMenu
          label="ide.menu.view"
          actions={[
            {
              label: "ide.action.databaseExplorer",
              icon: "database",
              shortcut: "⌘1",
              onSelect: () => onArea("workspace"),
            },
            {
              label: "tabs.dashboard",
              icon: "dashboard",
              onSelect: () => onArea("dashboard"),
            },
            {
              label: "terminal.title",
              icon: "terminal",
              disabled: !selected,
              onSelect: onOpenTerminal,
            },
          ]}
        />
        <IdeMenu
          label="ide.menu.navigate"
          actions={[
            {
              label: "ide.action.findObject",
              icon: "search",
              onSelect: focusExplorer,
            },
            {
              label: "tabs.activity",
              icon: "history",
              disabled: !selected,
              onSelect: onOpenActivity,
            },
          ]}
        />
        <IdeMenu
          label="ide.menu.query"
          actions={[
            {
              label: "ide.action.newQuery",
              icon: "play",
              shortcut: "⌘⇧N",
              disabled: queryDisabled,
              onSelect: onNewQuery,
            },
            {
              label: "terminal.title",
              icon: "terminal",
              disabled: !selected,
              onSelect: onOpenTerminal,
            },
          ]}
        />
        <IdeMenu
          label="ide.menu.tools"
          actions={[
            {
              label: "ide.action.dataSources",
              icon: "database",
              onSelect: onNewConnection,
            },
            {
              label: "common.settings",
              icon: "gear",
              onSelect: onSettings,
            },
          ]}
        />
        <IdeMenu
          label="ide.menu.window"
          actions={[
            {
              label: "ide.action.databaseExplorer",
              icon: "sidebar",
              onSelect: () => onArea("workspace"),
            },
            {
              label: showTerminalDock
                ? "terminal.focusPanel"
                : "terminal.title",
              icon: "terminal",
              disabled: !selected,
              onSelect: onOpenTerminal,
            },
          ]}
        />
        <IdeMenu
          label="ide.menu.help"
          actions={[
            {
              label: "ide.action.about",
              icon: "info",
              onSelect: onSettings,
            },
          ]}
        />
      </div>

      <div
        className="tw:absolute tw:left-1/2 tw:flex tw:-translate-x-1/2 tw:items-center tw:gap-1 tw:[&_.btn]:[--ds-icon-button-size:28px] tw:max-[1280px]:hidden"
        role="toolbar"
        aria-label={t("ide.mainToolbar")}
      >
        <button
          type="button"
          className="btn small icon-only"
          onClick={() => onArea("workspace")}
          title={t("ide.action.databaseExplorer")}
          aria-label={t("ide.action.databaseExplorer")}
          aria-pressed={area === "workspace"}
        >
          <Icon name="database" />
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
        <button
          type="button"
          className="btn small icon-only"
          onClick={focusExplorer}
          title={t("ide.action.searchEverywhere")}
          aria-label={t("ide.action.searchEverywhere")}
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
