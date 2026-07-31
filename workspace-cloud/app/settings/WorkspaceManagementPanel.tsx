// Root settings navigation owns the active workspace concern. This component
// renders only that concern's command surface and never creates nested settings.
import { ConnectionAccessPanel } from "./ConnectionAccessPanel";
import { CloudAccountPanel } from "./CloudAccountPanel";
import { SharedDatabasePanel } from "./SharedDatabasePanel";
import { WorkspaceAccessPanel } from "./WorkspaceAccessPanel";

export type WorkspaceManagementArea =
  | "cloud-accounts"
  | "databases"
  | "database-access"
  | "members";

export const workspaceManagementAreas: Array<{
  id: WorkspaceManagementArea;
  index: string;
  label: string;
  description: string;
}> = [
  {
    id: "cloud-accounts",
    index: "02",
    label: "클라우드 계정",
    description: "DB를 찾고 단기 자격증명을 발급할 공급자 인증",
  },
  {
    id: "databases",
    index: "03",
    label: "공유 데이터베이스",
    description: "워크스페이스에서 함께 사용하는 고정 DB 대상",
  },
  {
    id: "database-access",
    index: "04",
    label: "DB별 접근 권한",
    description: "연결마다 보기·사용·관리 권한",
  },
  {
    id: "members",
    index: "05",
    label: "멤버 관리",
    description: "초대와 워크스페이스 역할",
  },
];

export function WorkspaceManagementPanel({
  workspaceId,
  gcpSetupId,
  initialIntegrationId,
  area,
}: {
  workspaceId: string;
  gcpSetupId: string | null;
  initialIntegrationId: string | null;
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
        {area === "cloud-accounts" ? (
          <CloudAccountPanel
            workspaceId={workspaceId}
            gcpSetupId={gcpSetupId}
          />
        ) : null}
        {area === "databases" ? (
          <SharedDatabasePanel
            workspaceId={workspaceId}
            initialIntegrationId={initialIntegrationId}
          />
        ) : null}
    </section>
  );
}
