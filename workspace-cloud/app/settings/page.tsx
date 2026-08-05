// Authenticated workspace and device-session console. Server rendering resolves the
// current Better Auth identity before exposing any organization administration UI.
import { and, eq, inArray } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "../../lib/auth";
import { db } from "../../lib/db";
import { acceptPendingWorkspaceInvitations } from "../../lib/pending-invitations";
import { member } from "../../lib/schema";
import { Brand } from "../components/Brand";
import {
  ConsoleNotice,
  ConsoleSectionHeading,
} from "../components/Console";
import { IdentityEyebrow } from "../components/Identity";
import { CreateWorkspaceForm } from "./CreateWorkspaceForm";
import { AccountSwitcher } from "./AccountSwitcher";
import { AccountManagementPanel } from "./AccountManagementPanel";
import {
  settingsSection,
  SettingsNavigation,
  type SettingsSection,
} from "./SettingsNavigation";
import {
  workspaceManagementAreas,
  WorkspaceManagementPanel,
  type WorkspaceManagementArea,
} from "./WorkspaceManagementPanel";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    workspace?: string | string[];
    provider?: string | string[];
    status?: string | string[];
    gcpSetup?: string | string[];
    integration?: string | string[];
    section?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const requestedSection: SettingsSection = settingsSection(params.section);
  const requestedWorkspaceId =
    typeof params.workspace === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.workspace)
      ? params.workspace
      : null;
  const requestedGcpSetupId =
    typeof params.gcpSetup === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(params.gcpSetup)
      ? params.gcpSetup
      : null;
  const requestedIntegrationId =
    typeof params.integration === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(params.integration)
      ? params.integration
      : null;
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  const encodedWorkspaceId = requestedWorkspaceId
    ? encodeURIComponent(requestedWorkspaceId)
    : null;
  const settingsPath = `/settings?${
    encodedWorkspaceId ? `workspace=${encodedWorkspaceId}&` : ""
  }section=${requestedSection}`;
  if (!session) {
    redirect(`/auth/sign-in?returnTo=${encodeURIComponent(settingsPath)}`);
  }
  await acceptPendingWorkspaceInvitations({
    api: auth.api,
    headers: requestHeaders,
    user: session.user,
    activeOrganizationId: session.session.activeOrganizationId,
  });
  const workspaces = await auth.api.listOrganizations({ headers: requestHeaders });
  const roleRows = workspaces.length > 0
    ? await db.select({ organizationId: member.organizationId, role: member.role })
        .from(member)
        .where(and(
          eq(member.userId, session.user.id),
          inArray(member.organizationId, workspaces.map((workspace) => workspace.id)),
        ))
    : [];
  const workspaceRoles = new Map(roleRows.map((row) => [row.organizationId, row.role]));
  const requestedWorkspace = workspaces.find(
    (workspace) => workspace.id === requestedWorkspaceId,
  ) ?? null;
  const sessionWorkspace = workspaces.find(
    (workspace) => workspace.id === session.session.activeOrganizationId,
  ) ?? null;
  const activeWorkspace = requestedWorkspace ?? sessionWorkspace ?? workspaces[0] ?? null;
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const orderedWorkspaces = activeWorkspaceId
    ? [
        ...workspaces.filter((workspace) => workspace.id === activeWorkspaceId),
        ...workspaces.filter((workspace) => workspace.id !== activeWorkspaceId),
      ]
    : workspaces;
  const activeSection: SettingsSection =
    requestedGcpSetupId || typeof params.provider === "string"
      ? "cloud-accounts"
      : requestedSection;
  const activeManagementArea: WorkspaceManagementArea | null =
    activeSection === "members"
    || activeSection === "database-access"
    || activeSection === "cloud-accounts"
    || activeSection === "databases"
      ? activeSection
      : null;
  const canManageActiveWorkspace = Boolean(
    activeWorkspace
    && ["admin", "owner"].includes(workspaceRoles.get(activeWorkspace.id) ?? ""),
  );
  const activeManagementDetails = activeManagementArea
    ? workspaceManagementAreas.find((item) => item.id === activeManagementArea)
    : null;
  const pageIndex = activeSection === "account"
    ? "06"
    : activeSection === "workspaces"
      ? "01"
      : activeManagementDetails?.index ?? "01";
  const pageTitle = activeSection === "account"
    ? "내 계정"
    : activeSection === "workspaces"
      ? "워크스페이스"
      : activeManagementDetails?.label ?? "워크스페이스";
  const pageDescription = activeSection === "account"
    ? "로그인 계정과 인증된 기기를 관리합니다. 이 경계는 어떤 워크스페이스에도 종속되지 않습니다."
    : activeSection === "workspaces"
      ? "팀이 함께 사용할 연결과 정책의 경계를 선택하거나 새로 만듭니다."
      : activeManagementDetails?.description ?? "공유 접근 경계를 관리합니다.";
  const activeRole = activeWorkspace
    ? workspaceRoles.get(activeWorkspace.id) ?? "member"
    : "선택 안 됨";

  return (
    <main className="tw:min-h-[100dvh]" id="main-content">
      <header className="tw:sticky tw:top-0 tw:z-20 tw:border-b tw:border-chrome-border tw:bg-chrome tw:text-chrome-foreground tw:shadow-[0_14px_40px_color-mix(in_srgb,var(--ds-chrome)_20%,transparent)]">
        <div className="tw:mx-auto tw:flex tw:min-h-[74px] tw:w-full tw:max-w-[1480px] tw:items-center tw:justify-between tw:gap-5 tw:px-[clamp(20px,4vw,64px)]">
          <Brand tone="inverse" />
          <span className="tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-2xs tw:text-chrome-muted tw:max-[860px]:hidden">
            <i className="tw:size-1.5 tw:rounded-full tw:bg-signal" />
            Shared access control plane
          </span>
          <AccountSwitcher
            currentSessionId={session.session.id}
            currentUser={{
              id: session.user.id,
              name: session.user.name,
              email: session.user.email,
            }}
          />
        </div>
        <SettingsNavigation
          activeSection={activeSection}
          workspaceId={activeWorkspaceId}
          gcpSetupId={requestedGcpSetupId}
          canManageWorkspace={canManageActiveWorkspace}
        />
      </header>
      <div className="tw:relative tw:mx-auto tw:w-full tw:max-w-[1480px] tw:px-[clamp(22px,5vw,76px)] tw:pt-[clamp(48px,7vw,88px)] tw:pb-[110px]">
        <header className="tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(300px,0.54fr)] tw:items-end tw:gap-[clamp(36px,7vw,100px)] tw:border-b tw:border-border tw:pb-[clamp(38px,5vw,64px)] tw:max-[820px]:grid-cols-1">
          <div>
            <IdentityEyebrow>CONTROL PLANE / {pageIndex}</IdentityEyebrow>
            <h1 className="tw:mt-4 tw:font-serif tw:text-[clamp(46px,6vw,76px)] tw:leading-[0.98] tw:font-normal tw:tracking-[-0.055em] tw:text-balance">
              {pageTitle}
            </h1>
            <p className="tw:mt-5 tw:max-w-[680px] tw:text-[15px] tw:leading-[1.75] tw:text-muted-foreground">
              {pageDescription}
            </p>
          </div>
          <dl className="tw:m-0 tw:grid tw:overflow-hidden tw:rounded-surface tw:border tw:border-border tw:bg-surface/85 tw:shadow-[0_16px_50px_color-mix(in_srgb,var(--ds-text)_6%,transparent)] tw:backdrop-blur">
            <div className="tw:grid tw:grid-cols-[110px_minmax(0,1fr)] tw:items-center tw:border-b tw:border-border tw:px-4 tw:py-3.5">
              <dt className="tw:font-mono tw:text-2xs tw:font-medium tw:text-muted-foreground">{activeSection === "account" ? "Account" : "Workspace"}</dt>
              <dd className="tw:m-0 tw:truncate tw:text-right tw:text-xs tw:font-medium tw:text-foreground">
                {activeSection === "account"
                  ? session.user.name
                  : activeWorkspace?.name ?? "선택 안 됨"}
              </dd>
            </div>
            <div className="tw:grid tw:grid-cols-[110px_minmax(0,1fr)] tw:items-center tw:px-4 tw:py-3.5">
              <dt className="tw:font-mono tw:text-2xs tw:font-medium tw:text-muted-foreground">{activeSection === "account" ? "Identity" : "Access"}</dt>
              <dd className="tw:m-0 tw:truncate tw:text-right tw:text-xs tw:text-primary">
                {activeSection === "account" ? session.user.email : activeRole}
              </dd>
            </div>
          </dl>
        </header>
        {activeSection === "cloud-accounts"
        && params.provider === "planetScale"
        && params.status === "connected" ? (
          <ConsoleNotice>
            PlanetScale 계정이 연결되었습니다. 공유 데이터베이스에서 DB와
            브랜치를 선택할 수 있습니다.
          </ConsoleNotice>
        ) : null}
        {activeSection === "cloud-accounts"
        && params.provider === "planetScale"
        && params.status === "failed" ? (
          <ConsoleNotice tone="danger">
            PlanetScale 연결을 완료하지 못했습니다. 권한과 서버 설정을 확인한
            뒤 다시 시도하세요.
          </ConsoleNotice>
        ) : null}
        {activeSection === "cloud-accounts"
        && params.provider === "gcpCloudSql"
        && params.status === "authorised" ? (
          <ConsoleNotice>
            Google 계정이 승인되었습니다. 아래에서 프로젝트와 Cloud SQL
            인스턴스를 선택하세요.
          </ConsoleNotice>
        ) : null}
        {activeSection === "cloud-accounts"
        && params.provider === "gcpCloudSql"
        && params.status === "failed" ? (
          <ConsoleNotice tone="danger">
            Google Cloud 승인을 완료하지 못했습니다. 계정과 OAuth 권한을
            확인한 뒤 다시 시도하세요.
          </ConsoleNotice>
        ) : null}
        {activeSection === "account" ? (
          <section id="account" className="tw:scroll-mt-32 tw:pt-[clamp(56px,7vw,88px)]">
            <ConsoleSectionHeading index="06" title="내 계정 관리">
              로그인 계정과 인증된 기기는 어떤 워크스페이스에도 종속되지 않습니다.
            </ConsoleSectionHeading>
            <AccountManagementPanel
              currentSessionId={session.session.id}
              user={{ name: session.user.name, email: session.user.email }}
            />
          </section>
        ) : null}

        {activeSection === "workspaces" ? (
          <section id="workspaces" className="tw:scroll-mt-32 tw:pt-[clamp(56px,7vw,88px)]">
            <ConsoleSectionHeading index="01" title="워크스페이스">
              연결과 대시보드를 공유할 팀 경계를 선택하거나 만듭니다.
            </ConsoleSectionHeading>
            <div className="tw:grid tw:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.62fr)] tw:items-start tw:gap-6 tw:max-[980px]:grid-cols-1">
              <div className="tw:overflow-hidden tw:rounded-panel tw:border tw:border-border tw:bg-surface tw:shadow-panel">
                {orderedWorkspaces.map((workspace) => (
                  <article
                    className="tw:scroll-mt-32 tw:border-b tw:border-border tw:last:border-b-0 tw:data-[focused=true]:bg-selection"
                    data-focused={workspace.id === activeWorkspaceId}
                    id={`workspace-${workspace.id}`}
                    key={workspace.id}
                  >
                    <a
                      className="tw:grid tw:min-h-[106px] tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-center tw:gap-4 tw:px-5 tw:py-4 tw:transition-colors tw:hover:bg-surface-raised tw:focus-visible:outline-2 tw:focus-visible:outline-offset-[-3px] tw:focus-visible:outline-ring tw:max-[560px]:grid-cols-[auto_minmax(0,1fr)]"
                      href={`/settings?workspace=${encodeURIComponent(workspace.id)}&section=members`}
                      aria-current={
                        workspace.id === activeWorkspaceId ? "true" : undefined
                      }
                    >
                      <div className="tw:grid tw:size-12 tw:place-items-center tw:rounded-surface tw:border tw:border-primary/20 tw:bg-surface-inset tw:font-mono tw:text-xs tw:font-medium tw:text-primary">
                        {workspace.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <h3 className="tw:mb-1 tw:text-[15px] tw:font-medium">
                          {workspace.name}
                        </h3>
                        <p className="tw:font-mono tw:text-2xs tw:text-muted-foreground">
                          {workspace.slug}
                        </p>
                      </div>
                      <span className="tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-2xs tw:text-primary tw:max-[560px]:col-start-2">
                        <i className="tw:size-1.5 tw:rounded-full tw:bg-success" />
                        {workspace.id === activeWorkspaceId
                          ? `${workspaceRoles.get(workspace.id)} · 현재`
                          : workspaceRoles.get(workspace.id)}
                      </span>
                    </a>
                  </article>
                ))}
                {workspaces.length === 0 ? (
                  <div className="tw:px-7 tw:py-16 tw:text-center">
                    <span className="tw:mx-auto tw:mb-4 tw:grid tw:size-12 tw:place-items-center tw:rounded-full tw:bg-selection tw:text-primary">＋</span>
                    <strong className="tw:block tw:text-sm tw:font-medium tw:text-foreground">
                      첫 워크스페이스를 만드세요
                    </strong>
                    <small className="tw:mt-2 tw:block tw:text-xs tw:text-muted-foreground">
                      공유 연결과 정책이 이 경계 안에 모입니다.
                    </small>
                  </div>
                ) : null}
              </div>
              <CreateWorkspaceForm />
            </div>
          </section>
        ) : null}

        {activeManagementArea
        && activeManagementDetails
        && activeWorkspace
        && canManageActiveWorkspace ? (
          <section
            className="tw:scroll-mt-32 tw:pt-[clamp(56px,7vw,88px)]"
            id="workspace-settings"
          >
            <ConsoleSectionHeading
              index={activeManagementDetails.index}
              title={activeManagementDetails.label}
            >
              {activeWorkspace.name} · {activeManagementDetails.description}
            </ConsoleSectionHeading>
            <WorkspaceManagementPanel
              workspaceId={activeWorkspace.id}
              workspaceName={activeWorkspace.name}
              workspaceSlug={activeWorkspace.slug}
              gcpSetupId={requestedGcpSetupId}
              initialIntegrationId={requestedIntegrationId}
              area={activeManagementArea}
            />
          </section>
        ) : null}
      </div>
    </main>
  );
}
