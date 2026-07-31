import type { WorkspaceManagementArea } from "./WorkspaceManagementPanel";

export type SettingsSection =
  | "account"
  | "workspaces"
  | WorkspaceManagementArea;

const workspaceSections: Array<{
  id: SettingsSection;
  index: string;
  label: string;
}> = [
  { id: "workspaces", index: "01", label: "워크스페이스" },
  { id: "members", index: "02", label: "멤버 관리" },
  { id: "database-access", index: "03", label: "DB별 접근 권한" },
  { id: "connections", index: "04", label: "공급자 및 DB 연결" },
];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string"
    && [...workspaceSections.map((item) => item.id), "account"].includes(value);
}

export function SettingsNavigation({
  activeSection,
  workspaceId,
  gcpSetupId,
  canManageWorkspace,
}: {
  activeSection: SettingsSection;
  workspaceId: string | null;
  gcpSetupId: string | null;
  canManageWorkspace: boolean;
}) {
  const workspaceQuery = workspaceId
    ? `workspace=${encodeURIComponent(workspaceId)}&`
    : "";

  return (
    <nav
      className="tw:mt-20 tw:grid tw:content-start tw:max-[800px]:order-3 tw:max-[800px]:col-span-full tw:max-[800px]:mt-4 tw:max-[800px]:flex tw:max-[800px]:overflow-x-auto tw:max-[800px]:border-t tw:max-[800px]:border-border"
      aria-label="설정"
    >
      <span className="tw:mb-2 tw:px-1 tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground tw:max-[800px]:hidden">
        Workspace
      </span>
      {workspaceSections.map((item) => {
        if (item.id !== "workspaces" && !canManageWorkspace) return null;
        const setupQuery = item.id === "connections" && gcpSetupId
          ? `&gcpSetup=${encodeURIComponent(gcpSetupId)}`
          : "";
        return (
          <a
            className="tw:flex tw:min-h-control-md tw:items-center tw:border-t tw:border-border tw:px-1 tw:text-ui tw:text-muted-foreground tw:transition-colors tw:hover:bg-surface-raised tw:hover:text-foreground tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:max-[800px]:min-w-max tw:max-[800px]:border-t-0 tw:max-[800px]:border-r tw:max-[800px]:px-3"
            data-active={activeSection === item.id}
            href={`/settings?${workspaceQuery}section=${item.id}${setupQuery}`}
            aria-current={activeSection === item.id ? "page" : undefined}
            key={item.id}
          >
            <span className="tw:mr-3 tw:font-mono tw:text-2xs tw:text-primary">
              {item.index}
            </span>
            {item.label}
          </a>
        );
      })}
      <span className="tw:mt-8 tw:mb-2 tw:px-1 tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground tw:max-[800px]:hidden">
        Account
      </span>
      <a
        className="tw:flex tw:min-h-control-md tw:items-center tw:border-y tw:border-border tw:px-1 tw:text-ui tw:text-muted-foreground tw:transition-colors tw:hover:bg-surface-raised tw:hover:text-foreground tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:max-[800px]:min-w-max tw:max-[800px]:border-y-0 tw:max-[800px]:px-3"
        data-active={activeSection === "account"}
        href="/settings?section=account"
        aria-current={activeSection === "account" ? "page" : undefined}
      >
        <span className="tw:mr-3 tw:font-mono tw:text-2xs tw:text-primary">
          05
        </span>
        내 계정
      </a>
    </nav>
  );
}
