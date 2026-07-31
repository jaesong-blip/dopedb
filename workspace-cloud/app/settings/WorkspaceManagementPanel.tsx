// Root settings navigation owns the active workspace concern. This component
// renders only that concern's command surface and never creates nested settings.
import { ConnectionAccessPanel } from "./ConnectionAccessPanel";
import { ProviderAccessPanel } from "./ProviderAccessPanel";
import { WorkspaceAccessPanel } from "./WorkspaceAccessPanel";

export type WorkspaceManagementArea = "connections" | "database-access" | "members";

export const workspaceManagementAreas: Array<{
  id: WorkspaceManagementArea;
  index: string;
  label: string;
  description: string;
}> = [
  {
    id: "members",
    index: "02",
    label: "멤버 관리",
    description: "초대와 워크스페이스 역할",
  },
  {
    id: "database-access",
    index: "03",
    label: "DB별 접근 권한",
    description: "연결마다 보기·사용·관리 권한",
  },
  {
    id: "connections",
    index: "04",
    label: "공급자 및 DB 연결",
    description: "공급자 계정과 공유 연결",
  },
];

export function WorkspaceManagementPanel({
  workspaceId,
  gcpSetupId,
  area,
}: {
  workspaceId: string;
  gcpSetupId: string | null;
  area: WorkspaceManagementArea;
}) {
  const selected =
    workspaceManagementAreas.find((item) => item.id === area)
    ?? workspaceManagementAreas[0];

  return (
    <section className="tw:min-w-0 tw:border tw:border-border tw:bg-surface">
        <header className="tw:flex tw:items-start tw:justify-between tw:gap-4 tw:border-b tw:border-border tw:px-5 tw:py-4">
          <div className="tw:grid tw:gap-1">
            <span className="tw:font-mono tw:text-2xs tw:text-primary">
              {selected.index}
            </span>
            <h3 className="tw:m-0 tw:text-sm tw:font-semibold tw:text-foreground">
              {selected.label}
            </h3>
          </div>
          <p className="tw:m-0 tw:max-w-[38rem] tw:text-right tw:text-xs tw:leading-body tw:text-muted-foreground tw:max-[720px]:hidden">
            {selected.description}
          </p>
        </header>

        {area === "members" ? (
          <WorkspaceAccessPanel workspaceId={workspaceId} />
        ) : null}
        {area === "database-access" ? (
          <ConnectionAccessPanel workspaceId={workspaceId} />
        ) : null}
        {area === "connections" ? (
          <ProviderAccessPanel
            workspaceId={workspaceId}
            gcpSetupId={gcpSetupId}
          />
        ) : null}
    </section>
  );
}
