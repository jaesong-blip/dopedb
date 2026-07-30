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
import { ActiveSessions } from "./ActiveSessions";
import { ConnectionAccessPanel } from "./ConnectionAccessPanel";
import { WorkspaceAccessPanel } from "./WorkspaceAccessPanel";
import { ProviderAccessPanel } from "./ProviderAccessPanel";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    workspace?: string | string[];
    provider?: string | string[];
    status?: string | string[];
    gcpSetup?: string | string[];
  }>;
}) {
  const params = await searchParams;
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
  const settingsPath = encodedWorkspaceId
    ? `/settings?workspace=${encodedWorkspaceId}#workspace-${encodedWorkspaceId}`
    : "/settings";
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
  const focusedWorkspaceId = workspaces.some(
    (workspace) => workspace.id === requestedWorkspaceId,
  )
    ? requestedWorkspaceId
    : null;
  const orderedWorkspaces = focusedWorkspaceId
    ? [
        ...workspaces.filter((workspace) => workspace.id === focusedWorkspaceId),
        ...workspaces.filter((workspace) => workspace.id !== focusedWorkspaceId),
      ]
    : workspaces;

  return (
    <main className="tw:grid tw:min-h-screen tw:grid-cols-[250px_minmax(0,1fr)] tw:max-[800px]:block">
      <aside className="tw:sticky tw:top-0 tw:flex tw:min-h-screen tw:flex-col tw:border-r tw:border-border tw:bg-background/80 tw:p-7 tw:max-[800px]:static tw:max-[800px]:min-h-0 tw:max-[800px]:flex-row tw:max-[800px]:items-center tw:max-[800px]:justify-between tw:max-[800px]:border-r-0 tw:max-[800px]:border-b">
        <Brand />
        <nav className="tw:mt-[100px] tw:grid tw:max-[800px]:hidden">
          <a
            className="tw:border-t tw:border-border tw:px-1 tw:py-4 tw:text-ui tw:text-foreground"
            href="#workspaces"
          >
            <span className="tw:mr-3 tw:font-mono tw:text-2xs tw:text-primary">
              01
            </span>{" "}
            Workspaces
          </a>
          <a
            className="tw:border-y tw:border-border tw:px-1 tw:py-4 tw:text-ui tw:text-muted-foreground tw:hover:text-foreground"
            href="#devices"
          >
            <span className="tw:mr-3 tw:font-mono tw:text-2xs tw:text-primary">
              02
            </span>{" "}
            Devices
          </a>
        </nav>
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
              워크스페이스 설정
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
        {params.provider === "planetScale" && params.status === "connected" ? (
          <ConsoleNotice>
            PlanetScale 계정이 연결되었습니다. 아래에서 DB와 브랜치를
            선택하세요.
          </ConsoleNotice>
        ) : null}
        {params.provider === "planetScale" && params.status === "failed" ? (
          <ConsoleNotice tone="danger">
            PlanetScale 연결을 완료하지 못했습니다. 권한과 서버 설정을 확인한
            뒤 다시 시도하세요.
          </ConsoleNotice>
        ) : null}
        {params.provider === "gcpCloudSql" && params.status === "authorised" ? (
          <ConsoleNotice>
            Google 계정이 승인되었습니다. 아래에서 프로젝트와 Cloud SQL
            인스턴스를 선택하세요.
          </ConsoleNotice>
        ) : null}
        {params.provider === "gcpCloudSql" && params.status === "failed" ? (
          <ConsoleNotice tone="danger">
            Google Cloud 승인을 완료하지 못했습니다. 계정과 OAuth 권한을
            확인한 뒤 다시 시도하세요.
          </ConsoleNotice>
        ) : null}
        <section
          id="workspaces"
          className="tw:scroll-mt-5 tw:pt-[58px]"
        >
          <ConsoleSectionHeading index="01" title="Workspaces">
            Better Auth Organization 멤버십이 권한 경계를 관리합니다.
          </ConsoleSectionHeading>
          <div className="tw:grid tw:grid-cols-2 tw:gap-2.5 tw:max-[1100px]:grid-cols-1">
            {orderedWorkspaces.map((workspace) => (
              <article
                className="tw:scroll-mt-6 tw:border tw:border-border tw:bg-surface tw:transition-[border-color,box-shadow] tw:target:border-primary/60 tw:target:shadow-[0_0_0_1px_color-mix(in_srgb,var(--ds-accent)_18%,transparent)] tw:data-[focused=true]:border-primary/60 tw:data-[focused=true]:shadow-[0_0_0_1px_color-mix(in_srgb,var(--ds-accent)_18%,transparent)]"
                data-focused={workspace.id === focusedWorkspaceId}
                id={`workspace-${workspace.id}`}
                key={workspace.id}
              >
                <div className="tw:grid tw:min-h-[126px] tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-center tw:gap-[18px] tw:border-b tw:border-border tw:p-[22px]">
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
                    {workspaceRoles.get(workspace.id)}
                  </span>
                </div>
                {["admin", "owner"].includes(workspaceRoles.get(workspace.id) ?? "") ? (
                  <>
                    <WorkspaceAccessPanel workspaceId={workspace.id} />
                    <ConnectionAccessPanel workspaceId={workspace.id} />
                    <ProviderAccessPanel
                      workspaceId={workspace.id}
                      gcpSetupId={
                        workspace.id === focusedWorkspaceId
                          ? requestedGcpSetupId
                          : null
                      }
                    />
                  </>
                ) : null}
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
        <section id="devices" className="tw:scroll-mt-5 tw:pt-[58px]">
          <ConsoleSectionHeading index="02" title="Active sessions">
            Better Auth가 관리하는 브라우저와 데스크톱 Bearer 세션입니다.
          </ConsoleSectionHeading>
          <ActiveSessions currentSessionId={session.session.id} />
        </section>
      </div>
    </main>
  );
}
