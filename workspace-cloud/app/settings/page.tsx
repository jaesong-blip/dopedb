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
  isSettingsSection,
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
    section?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const requestedSection: SettingsSection = isSettingsSection(params.section)
    ? params.section
    : "workspaces";
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
      ? "connections"
      : requestedSection;
  const activeManagementArea: WorkspaceManagementArea | null =
    activeSection === "members"
    || activeSection === "database-access"
    || activeSection === "connections"
      ? activeSection
      : null;
  const canManageActiveWorkspace = Boolean(
    activeWorkspace
    && ["admin", "owner"].includes(workspaceRoles.get(activeWorkspace.id) ?? ""),
  );
  const activeManagementDetails = activeManagementArea
    ? workspaceManagementAreas.find((item) => item.id === activeManagementArea)
    : null;

  return (
    <main className="tw:grid tw:min-h-screen tw:grid-cols-[250px_minmax(0,1fr)] tw:max-[800px]:block">
      <aside className="tw:sticky tw:top-0 tw:flex tw:min-h-screen tw:flex-col tw:border-r tw:border-border tw:bg-background/80 tw:p-7 tw:max-[800px]:static tw:max-[800px]:grid tw:max-[800px]:min-h-0 tw:max-[800px]:grid-cols-[minmax(0,1fr)_auto] tw:max-[800px]:items-center tw:max-[800px]:border-r-0 tw:max-[800px]:border-b tw:max-[800px]:px-[22px] tw:max-[800px]:py-4">
        <Brand />
        <SettingsNavigation
          activeSection={activeSection}
          workspaceId={activeWorkspaceId}
          gcpSetupId={requestedGcpSetupId}
          canManageWorkspace={canManageActiveWorkspace}
        />
        <AccountSwitcher
          currentSessionId={session.session.id}
          currentUser={{
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
          }}
        />
      </aside>
      <div className="tw:w-full tw:max-w-[1320px] tw:px-[clamp(32px,6vw,90px)] tw:pt-[52px] tw:pb-[90px] tw:max-[800px]:px-[22px] tw:max-[800px]:pt-[38px] tw:max-[800px]:pb-[70px]">
        <header className="tw:flex tw:items-end tw:justify-between tw:border-b tw:border-border tw:pb-10 tw:max-[800px]:items-start">
          <div>
            <IdentityEyebrow>BETTER AUTH / DRIZZLE</IdentityEyebrow>
            <h1 className="tw:mt-3 tw:mb-0 tw:font-serif tw:text-[clamp(40px,5vw,68px)] tw:font-normal tw:tracking-[-0.055em]">
              {activeSection === "account" ? "내 계정" : "워크스페이스 설정"}
            </h1>
          </div>
          <div className="tw:flex tw:items-center tw:gap-2.5">
            <span className="tw:grid tw:size-9 tw:place-items-center tw:rounded-full tw:bg-primary-emphasis tw:font-extrabold tw:text-primary-foreground">
              {session.user.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="tw:flex tw:flex-col tw:gap-0.5 tw:max-[800px]:hidden">
              <strong className="tw:text-ui tw:text-foreground">
                {session.user.name}
              </strong>
              <small className="tw:text-xs tw:text-muted-foreground">
                {session.user.email}
              </small>
            </div>
          </div>
        </header>
        {activeSection === "connections"
        && params.provider === "planetScale"
        && params.status === "connected" ? (
          <ConsoleNotice>
            PlanetScale 계정이 연결되었습니다. 아래에서 DB와 브랜치를
            선택하세요.
          </ConsoleNotice>
        ) : null}
        {activeSection === "connections"
        && params.provider === "planetScale"
        && params.status === "failed" ? (
          <ConsoleNotice tone="danger">
            PlanetScale 연결을 완료하지 못했습니다. 권한과 서버 설정을 확인한
            뒤 다시 시도하세요.
          </ConsoleNotice>
        ) : null}
        {activeSection === "connections"
        && params.provider === "gcpCloudSql"
        && params.status === "authorised" ? (
          <ConsoleNotice>
            Google 계정이 승인되었습니다. 아래에서 프로젝트와 Cloud SQL
            인스턴스를 선택하세요.
          </ConsoleNotice>
        ) : null}
        {activeSection === "connections"
        && params.provider === "gcpCloudSql"
        && params.status === "failed" ? (
          <ConsoleNotice tone="danger">
            Google Cloud 승인을 완료하지 못했습니다. 계정과 OAuth 권한을
            확인한 뒤 다시 시도하세요.
          </ConsoleNotice>
        ) : null}
        {activeSection === "account" ? (
          <section id="account" className="tw:scroll-mt-5 tw:pt-[58px]">
            <ConsoleSectionHeading index="05" title="내 계정 관리">
              로그인 계정과 인증된 기기는 어떤 워크스페이스에도 종속되지 않습니다.
            </ConsoleSectionHeading>
            <AccountManagementPanel
              currentSessionId={session.session.id}
              user={{ name: session.user.name, email: session.user.email }}
            />
          </section>
        ) : null}

        {activeSection === "workspaces" ? (
          <section id="workspaces" className="tw:scroll-mt-5 tw:pt-[58px]">
            <ConsoleSectionHeading index="01" title="워크스페이스">
              연결과 대시보드를 공유할 팀 경계를 선택하거나 만듭니다.
            </ConsoleSectionHeading>
            <div className="tw:grid tw:grid-cols-2 tw:gap-2.5 tw:max-[1100px]:grid-cols-1">
              {orderedWorkspaces.map((workspace) => (
                <article
                  className="tw:scroll-mt-6 tw:border tw:border-border tw:bg-surface tw:transition-[border-color,box-shadow] tw:data-[focused=true]:border-primary/60 tw:data-[focused=true]:shadow-[0_0_0_1px_color-mix(in_srgb,var(--ds-accent)_18%,transparent)]"
                  data-focused={workspace.id === activeWorkspaceId}
                  id={`workspace-${workspace.id}`}
                  key={workspace.id}
                >
                  <a
                    className="tw:grid tw:min-h-[126px] tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-center tw:gap-[18px] tw:p-[22px] tw:transition-colors tw:hover:bg-surface-raised tw:focus-visible:outline-2 tw:focus-visible:outline-offset-[-2px] tw:focus-visible:outline-ring"
                    href={`/settings?workspace=${encodeURIComponent(workspace.id)}&section=members`}
                    aria-current={
                      workspace.id === activeWorkspaceId ? "true" : undefined
                    }
                  >
                    <div className="tw:grid tw:size-12 tw:place-items-center tw:border tw:border-primary/45 tw:font-mono tw:text-sm tw:text-primary">
                      {workspace.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <h3 className="tw:mt-0 tw:mb-1 tw:text-[14px]">
                        {workspace.name}
                      </h3>
                      <p className="tw:m-0 tw:font-mono tw:text-2xs tw:text-muted-foreground tw:uppercase">
                        {workspace.slug}
                      </p>
                    </div>
                    <span className="tw:flex tw:items-center tw:gap-1.5 tw:font-mono tw:text-2xs tw:text-primary">
                      <i className="tw:size-1.5 tw:rounded-full tw:bg-success" />
                      {workspace.id === activeWorkspaceId
                        ? `${workspaceRoles.get(workspace.id)} · 선택됨`
                        : workspaceRoles.get(workspace.id)}
                    </span>
                  </a>
                </article>
              ))}
              {workspaces.length === 0 ? (
                <div className="tw:col-span-full tw:border tw:border-dashed tw:border-border tw:px-6 tw:py-12 tw:text-center tw:text-ui tw:text-muted-foreground">
                  아직 연결된 워크스페이스가 없습니다.
                </div>
              ) : null}
            </div>
            <CreateWorkspaceForm />
          </section>
        ) : null}

        {activeManagementArea
        && activeManagementDetails
        && activeWorkspace
        && canManageActiveWorkspace ? (
          <section
            className="tw:scroll-mt-5 tw:pt-[58px]"
            id="workspace-settings"
          >
            <ConsoleSectionHeading
              index={activeManagementDetails.index}
              title={activeManagementDetails.label}
            >
              {activeWorkspace.name} · {activeManagementDetails.description}
            </ConsoleSectionHeading>
            <header className="tw:flex tw:items-center tw:justify-between tw:gap-4 tw:border-x tw:border-t tw:border-border tw:bg-surface-inset tw:px-5 tw:py-3">
              <div className="tw:grid tw:gap-1">
                <strong className="tw:text-sm tw:text-foreground">
                  {activeWorkspace.name}
                </strong>
                <small className="tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground">
                  {activeWorkspace.slug}
                </small>
              </div>
              <a
                className="tw:text-xs tw:text-primary tw:hover:text-foreground"
                href={`/settings?workspace=${encodeURIComponent(activeWorkspace.id)}&section=workspaces`}
              >
                워크스페이스 변경
              </a>
            </header>
            <WorkspaceManagementPanel
              workspaceId={activeWorkspace.id}
              gcpSetupId={requestedGcpSetupId}
              area={activeManagementArea}
            />
          </section>
        ) : null}
      </div>
    </main>
  );
}
