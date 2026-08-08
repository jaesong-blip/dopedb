import type { WorkspaceManagementArea } from "./WorkspaceManagementPanel";
import { localizedWorkspacePath, type WorkspaceLocale } from "../../lib/workspace-locale";
import { workspaceMessages } from "../../lib/workspace-messages";

export type SettingsSection =
  | "account"
  | "workspaces"
  | WorkspaceManagementArea;

const workspaceSections: Array<{
  id: SettingsSection;
  index: string;
}> = [
  { id: "workspaces", index: "01" },
  { id: "cloud-accounts", index: "02" },
  { id: "databases", index: "03" },
  { id: "database-access", index: "04" },
  { id: "dashboards", index: "05" },
  { id: "reports", index: "06" },
  { id: "monitoring", index: "07" },
  { id: "members", index: "08" },
  { id: "lifecycle", index: "09" },
];

export function settingsSection(value: unknown): SettingsSection {
  if (value === "connections") return "databases";
  return typeof value === "string"
      && [...workspaceSections.map((item) => item.id), "account"].includes(value)
    ? value as SettingsSection
    : "workspaces";
}

export function SettingsNavigation({
  activeSection,
  workspaceId,
  gcpSetupId,
  canManageWorkspace,
  canEditWorkspace,
  canDeleteWorkspace,
  workspaceDeletionPending,
  locale,
}: {
  activeSection: SettingsSection;
  workspaceId: string | null;
  gcpSetupId: string | null;
  canManageWorkspace: boolean;
  canEditWorkspace: boolean;
  canDeleteWorkspace: boolean;
  workspaceDeletionPending: boolean;
  locale: WorkspaceLocale;
}) {
  const copy = workspaceMessages[locale];
  const workspaceQuery = workspaceId
    ? `workspace=${encodeURIComponent(workspaceId)}&`
    : "";

  return (
    <nav
      className="tw:mx-auto tw:flex tw:w-full tw:max-w-[1480px] tw:overflow-x-auto tw:border-t tw:border-chrome-border tw:px-[clamp(20px,4vw,64px)] tw:[scrollbar-width:none]"
      aria-label={copy.common.settings}
    >
      {workspaceSections.map((item) => {
        if (
          workspaceDeletionPending
          && item.id !== "workspaces"
          && item.id !== "lifecycle"
        ) return null;
        if (item.id === "dashboards" && !canEditWorkspace) return null;
        if (item.id === "lifecycle" && !canDeleteWorkspace) return null;
        if (
          item.id !== "workspaces"
          && item.id !== "dashboards"
          && item.id !== "reports"
          && item.id !== "monitoring"
          && item.id !== "lifecycle"
          && !canManageWorkspace
        ) {
          return null;
        }
        const setupQuery = item.id === "cloud-accounts" && gcpSetupId
          ? `&gcpSetup=${encodeURIComponent(gcpSetupId)}`
          : "";
        const label = item.id === "workspaces"
          ? copy.settings.workspacesTitle
          : item.id === "cloud-accounts"
            ? copy.settings.areas.cloudAccounts.label
            : item.id === "databases"
              ? copy.settings.areas.databases.label
              : item.id === "database-access"
                ? copy.settings.areas.databaseAccess.label
                : item.id === "dashboards"
                  ? copy.settings.areas.dashboards.label
                  : item.id === "reports"
                    ? copy.settings.areas.reports.label
                    : item.id === "monitoring"
                      ? copy.settings.areas.monitoring.label
                    : item.id === "members"
                      ? copy.settings.areas.members.label
                      : copy.settings.areas.lifecycle.label;
        return (
          <a
            className="tw:flex tw:min-h-[48px] tw:min-w-max tw:items-center tw:border-b-2 tw:border-transparent tw:px-3 tw:text-xs tw:font-medium tw:text-chrome-muted tw:transition-colors tw:hover:bg-chrome-foreground/5 tw:hover:text-chrome-foreground tw:data-[active=true]:border-signal tw:data-[active=true]:text-chrome-foreground"
            data-active={activeSection === item.id}
            href={localizedWorkspacePath(
              `/settings?${workspaceQuery}section=${item.id}${setupQuery}`,
              locale,
            )}
            aria-current={activeSection === item.id ? "page" : undefined}
            key={item.id}
          >
            <span className="tw:mr-2.5 tw:font-mono tw:text-2xs tw:text-signal">
              {item.index}
            </span>
            {label}
          </a>
        );
      })}
      <a
        className="tw:ml-auto tw:flex tw:min-h-[48px] tw:min-w-max tw:items-center tw:border-b-2 tw:border-transparent tw:px-3 tw:text-xs tw:font-medium tw:text-chrome-muted tw:transition-colors tw:before:mr-3 tw:before:h-4 tw:before:w-px tw:before:bg-chrome-border tw:before:content-[''] tw:hover:bg-chrome-foreground/5 tw:hover:text-chrome-foreground tw:data-[active=true]:border-signal tw:data-[active=true]:text-chrome-foreground tw:max-[760px]:ml-0"
        data-active={activeSection === "account"}
        href={localizedWorkspacePath("/settings?section=account", locale)}
        aria-current={activeSection === "account" ? "page" : undefined}
      >
        <span className="tw:mr-2.5 tw:font-mono tw:text-2xs tw:text-signal">
          10
        </span>
        {copy.settings.accountTitle}
      </a>
    </nav>
  );
}
