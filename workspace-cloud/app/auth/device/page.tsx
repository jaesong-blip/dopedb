// Browser half of the RFC 8628 device flow. It verifies the short-lived code on the
// server and requires an explicit approve or deny action from the signed-in user.
import { headers } from "next/headers";
import { Brand } from "../../components/Brand";
import { LocaleSwitcher } from "../../components/LocaleSwitcher";
import {
  IdentityBody,
  IdentityCard,
  IdentityError,
  IdentityEyebrow,
  IdentitySingleShell,
  IdentityTitle,
} from "../../components/Identity";
import { auth } from "../../../lib/auth";
import { localizedWorkspacePath } from "../../../lib/workspace-locale";
import { getWorkspaceLocale } from "../../../lib/workspace-locale-server";
import { workspaceMessages } from "../../../lib/workspace-messages";
import { DeviceApproval } from "./DeviceApproval";
import { DeviceAccountActions } from "./DeviceAccountActions";
import { SignInButton } from "../sign-in/SignInButton";

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string; error?: string }>;
}) {
  const params = await searchParams;
  const locale = await getWorkspaceLocale();
  const copy = workspaceMessages[locale].device;
  const userCode = params.user_code?.trim() ?? "";
  const valid = /^[A-Z2-9-]{6,20}$/i.test(userCode);
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  let verificationError = params.error ? copy.invalidRequest : "";

  if (valid) {
    try {
      await auth.api.deviceVerify({ query: { user_code: userCode }, headers: requestHeaders });
    } catch {
      verificationError = copy.invalidCode;
    }
  }

  const returnTo = localizedWorkspacePath(
    `/auth/device?user_code=${encodeURIComponent(userCode)}`,
    locale,
  );
  return (
    <IdentitySingleShell>
      <div className="tw:flex tw:w-full tw:items-center tw:justify-between tw:gap-4">
        <Brand />
        <LocaleSwitcher />
      </div>
      <div className="tw:m-auto tw:w-[min(540px,100%)]">
        <IdentityCard>
          <div className="tw:relative tw:mb-10 tw:grid tw:size-14 tw:place-items-center tw:rounded-surface tw:border tw:border-primary/20 tw:bg-selection">
            <span className="tw:text-primary">↗</span>
          </div>
          <IdentityEyebrow>BETTER AUTH / RFC 8628</IdentityEyebrow>
          <IdentityTitle>{copy.title}</IdentityTitle>
          <IdentityBody>
            {copy.description}
          </IdentityBody>
          {!valid || verificationError ? (
            <IdentityError>
              {verificationError || copy.codeRequired}
            </IdentityError>
          ) : session ? (
            <div>
              <div className="tw:mt-7 tw:flex tw:items-center tw:gap-3 tw:border tw:border-border tw:bg-surface-raised tw:p-3">
                <span className="tw:grid tw:size-9 tw:place-items-center tw:rounded-control tw:bg-selection tw:font-semibold tw:text-primary">
                  {session.user.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="tw:flex tw:flex-col tw:gap-0.5">
                  <strong className="tw:text-ui tw:text-foreground">
                    {session.user.name}
                  </strong>
                  <small className="tw:text-xs tw:text-muted-foreground">
                    {session.user.email}
                  </small>
                </div>
              </div>
              <DeviceAccountActions
                currentUserId={session.user.id}
                userCode={userCode}
              />
              <DeviceApproval userCode={userCode} />
            </div>
          ) : (
            <SignInButton returnTo={returnTo} />
          )}
          <small className="tw:mt-4 tw:block tw:text-xs tw:text-muted-foreground">
            {copy.expires}
          </small>
        </IdentityCard>
      </div>
    </IdentitySingleShell>
  );
}
