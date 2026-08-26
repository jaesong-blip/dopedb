// Agent context exposes two user choices only: one Project's production data
// context or one exact database. Internal Environment grants stay invisible.

import { Icon } from "../../components/Icon";
import ToolbarMenu, {
  ToolbarMenuItem,
} from "../../components/ToolbarMenu";
import { EnvironmentBadge } from "../../design-system/components/EnvironmentBadge";
import { useI18n } from "../../lib/i18n";
import { knowledgeEnvironmentBadge } from "../knowledge/presentation";
import type { AcpChatController } from "./useAcpChatController";

export function AcpScopeSelect({
  knowledge,
  starting,
  onSelect,
}: {
  knowledge: AcpChatController["setup"]["knowledge"];
  starting: boolean;
  onSelect: (scopeKey: string | null) => void;
}) {
  const { t } = useI18n();
  if (!knowledge.success) return null;

  const selectedProject = knowledge.projectScopes.find(
    (scope) => scope.key === knowledge.selectedScopeKey,
  );
  const selectedDatabase = knowledge.databaseScopes.find(
    (scope) => scope.key === knowledge.selectedScopeKey,
  );
  const selectedMarker = selectedDatabase
    ? knowledgeEnvironmentBadge(selectedDatabase.riskClass)
    : null;
  const visibleSelection = selectedProject
    ? t("agent.acpProjectScopeTrigger", {
        project: selectedProject.projectName,
      })
    : selectedDatabase
      ? t("agent.acpDatabaseScopeTrigger", {
          database: selectedDatabase.databaseName,
        })
      : t("agent.acpSelectScope");
  const accessibleSelection = selectedProject
    ? t("agent.acpCurrentProjectScope", {
        project: selectedProject.projectName,
        count: selectedProject.databaseCount,
      })
    : selectedDatabase
      ? t("agent.acpCurrentDatabaseScope", {
          database: selectedDatabase.databaseName,
          marker: selectedMarker?.toUpperCase() ?? "",
          project: selectedDatabase.projectName,
        })
      : t("agent.acpSelectScope");

  return (
    <span className="tw:ml-auto tw:min-w-0 tw:max-w-[14rem]">
      <ToolbarMenu
        label={accessibleSelection}
        align="end"
        menuSize="scope"
        disabled={
          starting ||
          !knowledge.scopeChangeAllowed ||
          knowledge.reconfirmingEnvironmentId !== null
        }
        trigger={
          <span
            className="tw:flex tw:min-w-0 tw:max-w-[13rem] tw:items-center tw:gap-1.5"
            title={accessibleSelection}
          >
            <span className="tw:min-w-0 tw:truncate">
              {visibleSelection}
            </span>
            {selectedMarker ? (
              <EnvironmentBadge environment={selectedMarker} />
            ) : null}
            <Icon
              name="chevronDown"
              className="tw:shrink-0 tw:text-muted-foreground"
            />
          </span>
        }
      >
        {knowledge.projectScopes.length > 0 ? (
          <div
            role="group"
            aria-label={t("agent.acpProjectScopeGroup")}
            className="tw:grid tw:gap-0.5"
          >
            <div
              role="presentation"
              className="tw:px-2 tw:pt-1.5 tw:pb-1 tw:text-2xs tw:font-semibold tw:tracking-[0.05em] tw:text-muted-foreground tw:uppercase"
            >
              {t("agent.acpProjectScopeGroup")}
            </div>
            {knowledge.projectScopes.map((scope) => {
              const selected = scope.key === knowledge.selectedScopeKey;
              return (
                <ToolbarMenuItem
                  key={scope.key}
                  icon="folder"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => onSelect(scope.key)}
                >
                  <span className="tw:grid tw:min-w-0 tw:flex-1 tw:gap-0.5">
                    <span className="tw:truncate tw:text-sm tw:font-medium">
                      {scope.projectName}
                    </span>
                    <span className="tw:truncate tw:text-xs tw:font-normal tw:text-muted-foreground">
                      {t("agent.acpProjectScopeDescription", {
                        count: scope.databaseCount,
                      })}
                      {scope.needsReconfirmation
                        ? ` · ${t("agent.acpEnvironmentReconfirm")}`
                        : ""}
                    </span>
                  </span>
                  {selected ? (
                    <Icon name="check" className="tw:shrink-0 tw:text-success" />
                  ) : null}
                </ToolbarMenuItem>
              );
            })}
          </div>
        ) : null}
        {knowledge.databaseScopes.length > 0 ? (
          <div
            role="group"
            aria-label={t("agent.acpDatabaseScopeGroup")}
            data-separated={knowledge.projectScopes.length > 0}
            className="tw:grid tw:gap-0.5 tw:data-[separated=true]:border-t tw:data-[separated=true]:border-border-subtle tw:data-[separated=true]:pt-1"
          >
            <div
              role="presentation"
              className="tw:px-2 tw:pt-1 tw:pb-1 tw:text-2xs tw:font-semibold tw:tracking-[0.05em] tw:text-muted-foreground tw:uppercase"
            >
              {t("agent.acpDatabaseScopeGroup")}
            </div>
            {knowledge.databaseScopes.map((scope) => {
              const selected = scope.key === knowledge.selectedScopeKey;
              const marker = knowledgeEnvironmentBadge(scope.riskClass);
              return (
                <ToolbarMenuItem
                  key={scope.key}
                  icon="database"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => onSelect(scope.key)}
                >
                  <span className="tw:grid tw:min-w-0 tw:flex-1 tw:gap-0.5">
                    <span className="tw:truncate tw:text-sm tw:font-medium">
                      {scope.databaseName}
                    </span>
                    <span className="tw:truncate tw:text-xs tw:font-normal tw:text-muted-foreground">
                      {scope.projectName}
                      {scope.needsReconfirmation
                        ? ` · ${t("agent.acpEnvironmentReconfirm")}`
                        : ""}
                    </span>
                  </span>
                  <span className="tw:flex tw:shrink-0 tw:items-center tw:gap-1.5">
                    <EnvironmentBadge environment={marker} />
                    {selected ? (
                      <Icon name="check" className="tw:text-success" />
                    ) : null}
                  </span>
                </ToolbarMenuItem>
              );
            })}
          </div>
        ) : null}
      </ToolbarMenu>
    </span>
  );
}
