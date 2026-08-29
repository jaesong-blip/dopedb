// First-run launch actions shown when the workspace has no local connections.
import EngineMark from "../../components/EngineMark";
import { Icon } from "../../components/Icon";
import type { ConnectionLaunchPreset } from "../../features/connections/presets";
import {
  ToolWindowAction,
  ToolWindowSection,
} from "../../design-system/components/ToolWindow";
import type { ProviderKind } from "../../features/providers/domain";
import { useI18n } from "../../lib/i18n";

export function DatabaseExplorerEmptyState({
  creatingDemo,
  onNewConnection,
  onOpenProviderCredentials,
  onCreateDemoDatabase,
}: {
  creatingDemo: boolean;
  onNewConnection: (preset?: ConnectionLaunchPreset) => void;
  onOpenProviderCredentials: (provider: ProviderKind) => void;
  onCreateDemoDatabase: () => void;
}) {
  const { t } = useI18n();
  const launch = (label: string, preset: ConnectionLaunchPreset) => (
    <ToolWindowAction
      leading={<EngineMark engine={preset.engine ?? "postgres"} />}
      trailing={<Icon name="chevronRight" />}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        onNewConnection(preset);
      }}
    >
      {label}
    </ToolWindowAction>
  );
  return (
    <div className="tw:grid tw:gap-5 tw:p-3">
      <ToolWindowSection title={t("connections.createDataSource")}>
        {launch("PostgreSQL", { engine: "postgres", source: "standard" })}
        {launch("MySQL / MariaDB", { engine: "mysql", source: "standard" })}
        {launch("SQLite", {
          engine: "sqlite",
          provider: "generic",
          source: "standard",
        })}
        {launch("MongoDB", { engine: "mongodb", source: "standard" })}
        <ToolWindowAction
          leading={<Icon name="moreVertical" />}
          trailing={<Icon name="chevronRight" />}
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            onNewConnection();
          }}
        >
          {t("connections.allDataSources")}
        </ToolWindowAction>
      </ToolWindowSection>

      <ToolWindowSection title={t("connections.dataSourceFromCloudProvider")}>
        <ToolWindowAction
          leading={<Icon name="key" />}
          trailing={<Icon name="chevronRight" />}
          onClick={() => onOpenProviderCredentials("gcpCloudSql")}
        >
          {t("connections.providerGcpCloudSql")}
        </ToolWindowAction>
      </ToolWindowSection>

      <ToolWindowSection title={t("connections.sampleDatabase")}>
        <ToolWindowAction
          leading={<EngineMark engine="sqlite" />}
          trailing={<Icon name="download" />}
          disabled={creatingDemo}
          onClick={onCreateDemoDatabase}
        >
          {creatingDemo
            ? t("connections.demoCreating")
            : t("connections.demoSqlite")}
        </ToolWindowAction>
      </ToolWindowSection>
    </div>
  );
}
