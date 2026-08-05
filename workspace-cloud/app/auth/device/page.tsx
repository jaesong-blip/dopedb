// Browser half of the RFC 8628 device flow. It verifies the short-lived code on the
// server and requires an explicit approve or deny action from the signed-in user.
import { headers } from "next/headers";
import { Brand } from "../../components/Brand";
import {
  IdentityBody,
  IdentityCard,
  IdentityError,
  IdentityEyebrow,
  IdentitySingleShell,
  IdentityTitle,
} from "../../components/Identity";
import { auth } from "../../../lib/auth";
import { DeviceApproval } from "./DeviceApproval";
import { DeviceAccountActions } from "./DeviceAccountActions";
import { SignInButton } from "../sign-in/SignInButton";

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string; error?: string }>;
}) {
  const params = await searchParams;
  const userCode = params.user_code?.trim() ?? "";
  const valid = /^[A-Z2-9-]{6,20}$/i.test(userCode);
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  let verificationError = params.error ? "올바르지 않은 승인 요청입니다." : "";

  if (valid) {
    try {
      await auth.api.deviceVerify({ query: { user_code: userCode }, headers: requestHeaders });
    } catch {
      verificationError = "승인 코드가 올바르지 않거나 만료되었습니다.";
    }
  }

  const returnTo = `/auth/device?user_code=${encodeURIComponent(userCode)}`;
  return (
    <IdentitySingleShell>
      <Brand />
      <div className="tw:m-auto tw:w-[min(540px,100%)]">
        <IdentityCard>
          <div className="tw:relative tw:mb-10 tw:grid tw:size-14 tw:place-items-center tw:rounded-surface tw:border tw:border-primary/20 tw:bg-selection">
            <span className="tw:text-primary">↗</span>
          </div>
          <IdentityEyebrow>BETTER AUTH / RFC 8628</IdentityEyebrow>
          <IdentityTitle>이 기기를 연결할까요?</IdentityTitle>
          <IdentityBody>
            Better Auth의 표준 Device Authorization 흐름으로 데스크톱 앱에
            별도 세션을 발급합니다.
          </IdentityBody>
          {!valid || verificationError ? (
            <IdentityError>
              {verificationError || "올바른 승인 코드가 필요합니다."}
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
            승인 코드는 생성 후 10분 동안만 유효합니다.
          </small>
        </IdentityCard>
      </div>
    </IdentitySingleShell>
  );
}
