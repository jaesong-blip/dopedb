// Account identity and authenticated-device security belong to the user, not to
// any selected workspace, so this surface stays outside organization settings.
import { ActiveSessions } from "./ActiveSessions";

export function AccountManagementPanel({
  currentSessionId,
  user,
}: {
  currentSessionId: string;
  user: { email: string; name: string };
}) {
  return (
    <section className="tw:grid tw:border tw:border-border tw:bg-surface">
      <header className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:items-center tw:gap-4 tw:border-b tw:border-border tw:p-5">
        <span className="tw:grid tw:size-12 tw:place-items-center tw:rounded-full tw:bg-primary-emphasis tw:text-sm tw:font-extrabold tw:text-primary-foreground">
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="tw:grid tw:min-w-0 tw:gap-1">
          <strong className="tw:text-sm tw:text-foreground">{user.name}</strong>
          <small className="tw:overflow-hidden tw:text-xs tw:text-ellipsis tw:whitespace-nowrap tw:text-muted-foreground">
            {user.email}
          </small>
        </div>
      </header>
      <section className="tw:grid tw:p-5">
        <header className="tw:mb-3 tw:flex tw:items-start tw:justify-between tw:gap-4 tw:max-[720px]:block">
          <div className="tw:grid tw:gap-1">
            <strong className="tw:text-sm tw:text-foreground">
              인증된 기기 및 세션
            </strong>
            <small className="tw:text-xs tw:leading-body tw:text-muted-foreground">
              이 계정으로 로그인한 브라우저와 DopeDB Desktop을 관리합니다.
            </small>
          </div>
          <span className="tw:font-mono tw:text-2xs tw:uppercase tw:text-primary tw:max-[720px]:mt-2 tw:max-[720px]:block">
            Better Auth
          </span>
        </header>
        <ActiveSessions currentSessionId={currentSessionId} />
      </section>
    </section>
  );
}
