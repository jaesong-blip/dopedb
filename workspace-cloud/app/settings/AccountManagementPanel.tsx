// Account identity and authenticated-device security belong to the user, not to
// any selected workspace, so this surface stays outside organization settings.
"use client";

import { ActiveSessions } from "./ActiveSessions";
import { useWorkspaceLocale } from "../components/WorkspaceLocale";
import { workspaceMessages } from "../../lib/workspace-messages";

export function AccountManagementPanel({
  currentSessionId,
  user,
}: {
  currentSessionId: string;
  user: { email: string; name: string };
}) {
  const locale = useWorkspaceLocale();
  const copy = workspaceMessages[locale].account;
  return (
    <section className="tw:grid tw:overflow-hidden tw:rounded-panel tw:border tw:border-border tw:bg-surface tw:shadow-panel">
      <header className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:items-center tw:gap-4 tw:border-b tw:border-border tw:bg-surface-inset/70 tw:p-6">
        <span className="tw:grid tw:size-12 tw:place-items-center tw:rounded-surface tw:bg-selection tw:text-sm tw:font-semibold tw:text-primary">
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="tw:grid tw:min-w-0 tw:gap-1">
          <strong className="tw:text-sm tw:font-medium tw:text-foreground">{user.name}</strong>
          <small className="tw:overflow-hidden tw:text-xs tw:text-ellipsis tw:whitespace-nowrap tw:text-muted-foreground">
            {user.email}
          </small>
        </div>
      </header>
      <section className="tw:grid tw:p-6">
        <header className="tw:mb-3 tw:flex tw:items-start tw:justify-between tw:gap-4 tw:max-[720px]:block">
          <div className="tw:grid tw:gap-1">
            <strong className="tw:text-sm tw:text-foreground">
              {copy.sessionsTitle}
            </strong>
            <small className="tw:text-xs tw:leading-body tw:text-muted-foreground">
              {copy.sessionsDescription}
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
