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
  { id: "cloud-accounts", index: "02", label: "클라우드 계정" },
  { id: "databases", index: "03", label: "공유 데이터베이스" },
  { id: "database-access", index: "04", label: "DB별 접근 권한" },
  { id: "members", index: "05", label: "멤버 관리" },
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
      className="tw:mx-auto tw:flex tw:w-full tw:max-w-[1480px] tw:overflow-x-auto tw:border-t tw:border-chrome-border tw:px-[clamp(20px,4vw,64px)] tw:[scrollbar-width:none]"
      aria-label="설정"
    >
      {workspaceSections.map((item) => {
        if (item.id !== "workspaces" && !canManageWorkspace) return null;
        const setupQuery = item.id === "cloud-accounts" && gcpSetupId
          ? `&gcpSetup=${encodeURIComponent(gcpSetupId)}`
          : "";
        return (
          <a
            className="tw:flex tw:min-h-[48px] tw:min-w-max tw:items-center tw:border-b-2 tw:border-transparent tw:px-3 tw:text-xs tw:font-medium tw:text-chrome-muted tw:transition-colors tw:hover:bg-chrome-foreground/5 tw:hover:text-chrome-foreground tw:data-[active=true]:border-signal tw:data-[active=true]:text-chrome-foreground"
            data-active={activeSection === item.id}
            href={`/settings?${workspaceQuery}section=${item.id}${setupQuery}`}
            aria-current={activeSection === item.id ? "page" : undefined}
            key={item.id}
          >
            <span className="tw:mr-2.5 tw:font-mono tw:text-2xs tw:text-signal">
              {item.index}
            </span>
            {item.label}
          </a>
        );
      })}
      <a
        className="tw:ml-auto tw:flex tw:min-h-[48px] tw:min-w-max tw:items-center tw:border-b-2 tw:border-transparent tw:px-3 tw:text-xs tw:font-medium tw:text-chrome-muted tw:transition-colors tw:before:mr-3 tw:before:h-4 tw:before:w-px tw:before:bg-chrome-border tw:before:content-[''] tw:hover:bg-chrome-foreground/5 tw:hover:text-chrome-foreground tw:data-[active=true]:border-signal tw:data-[active=true]:text-chrome-foreground tw:max-[760px]:ml-0"
        data-active={activeSection === "account"}
        href="/settings?section=account"
        aria-current={activeSection === "account" ? "page" : undefined}
      >
        <span className="tw:mr-2.5 tw:font-mono tw:text-2xs tw:text-signal">
          06
        </span>
        내 계정
      </a>
    </nav>
  );
}
