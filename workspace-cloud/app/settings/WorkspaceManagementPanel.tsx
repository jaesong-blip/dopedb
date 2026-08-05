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
  workspaceName,
  workspaceSlug,
  gcpSetupId,
  initialIntegrationId,
  area,
}: {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  gcpSetupId: string | null;
  initialIntegrationId: string | null;
  area: WorkspaceManagementArea;
}) {
  const selected =
    workspaceManagementAreas.find((item) => item.id === area)
    ?? workspaceManagementAreas[0];

  return (
    <section className="tw:min-w-0 tw:overflow-hidden tw:rounded-panel tw:border tw:border-border tw:bg-surface tw:shadow-panel">
        <header className="tw:flex tw:items-center tw:justify-between tw:gap-5 tw:border-b tw:border-border tw:bg-surface-inset/70 tw:px-6 tw:py-4 tw:max-[640px]:items-start">
          <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-3">
            <span className="tw:grid tw:size-10 tw:shrink-0 tw:place-items-center tw:rounded-surface tw:bg-selection tw:font-mono tw:text-2xs tw:font-medium tw:text-primary">
              {workspaceName.slice(0, 2).toUpperCase()}
            </span>
            <div className="tw:grid tw:min-w-0 tw:gap-0.5">
              <h3 className="tw:truncate tw:text-sm tw:font-medium tw:text-foreground">
                {workspaceName}
              </h3>
              <span className="tw:truncate tw:font-mono tw:text-2xs tw:text-muted-foreground">
                {workspaceSlug} · {selected.index} {selected.label}
              </span>
            </div>
          </div>
          <a
            className="tw:shrink-0 tw:rounded-control tw:border tw:border-border tw:bg-surface tw:px-3 tw:py-2 tw:text-2xs tw:font-medium tw:text-muted-foreground tw:transition-colors tw:hover:border-primary tw:hover:text-primary"
            href={`/settings?workspace=${encodeURIComponent(workspaceId)}&section=workspaces`}
          >
            워크스페이스 변경
          </a>
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
