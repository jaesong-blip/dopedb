import { Brand } from "../../components/Brand";
import {
  IdentityCard,
  IdentityError,
  IdentityEyebrow,
} from "../../components/Identity";
import { safeReturnTo } from "../../../lib/http";
import { SignInButton } from "./SignInButton";

const messages: Record<string, string> = {
  oauth_state_missing: "로그인 요청이 만료되었습니다. 다시 시도해 주세요.",
  oauth_state_invalid: "로그인 요청을 확인할 수 없습니다. 다시 시작해 주세요.",
  email_not_verified: "확인된 Google 이메일이 필요합니다.",
  oauth_failed: "Google 로그인을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; error?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo ?? null);
  return (
    <main className="tw:relative tw:grid tw:min-h-screen tw:grid-rows-[auto_minmax(0,1fr)_auto] tw:overflow-hidden tw:px-10 tw:py-[30px] tw:after:absolute tw:after:bottom-[-65%] tw:after:left-[15%] tw:after:size-[640px] tw:after:rounded-full tw:after:border tw:after:border-primary/25 tw:after:shadow-[0_0_150px_color-mix(in_srgb,var(--ds-accent)_6%,transparent),inset_0_0_100px_color-mix(in_srgb,var(--ds-accent)_4%,transparent)] tw:after:content-[''] tw:max-[800px]:p-[22px]">
      <div className="tw:relative tw:z-[1] tw:flex tw:items-center tw:justify-between">
        <Brand />
        <span className="tw:font-mono tw:text-xs tw:tracking-[0.08em] tw:text-muted-foreground tw:uppercase tw:max-[800px]:hidden">
          <i className="tw:mr-2 tw:inline-block tw:size-1.5 tw:rounded-full tw:bg-primary tw:shadow-[0_0_14px_var(--ds-accent)]" />{" "}
          Identity gateway online
        </span>
      </div>
      <section className="tw:relative tw:z-[1] tw:m-auto tw:grid tw:w-[min(1180px,100%)] tw:grid-cols-[minmax(0,1fr)_minmax(380px,0.65fr)] tw:items-center tw:gap-[clamp(42px,6vw,90px)] tw:max-[800px]:grid-cols-1 tw:max-[800px]:gap-[42px] tw:max-[800px]:py-[70px]">
        <div>
          <IdentityEyebrow>CONTROL PLANE / 01</IdentityEyebrow>
          <h1 className="tw:my-6 tw:font-serif tw:text-[clamp(48px,5.5vw,80px)] tw:font-normal tw:leading-[0.98] tw:tracking-[-0.055em] tw:max-[800px]:text-[51px]">
            팀의 데이터 작업을
            <br />한 경계 안에서.
          </h1>
          <p className="tw:max-w-[530px] tw:text-[17px] tw:leading-[1.7] tw:text-[var(--ds-text-secondary)] tw:max-[800px]:hidden">
            워크스페이스는 연결 정보, 권한, 대시보드와 변경 이력을 팀 단위로
            분리합니다.
          </p>
          <div className="tw:mt-10 tw:flex tw:flex-wrap tw:gap-2 tw:max-[800px]:hidden">
            <span className="tw:border tw:border-border tw:px-3 tw:py-2 tw:font-mono tw:text-2xs tw:tracking-[0.08em] tw:text-muted-foreground tw:uppercase">
              Better Auth
            </span>
            <span className="tw:border tw:border-border tw:px-3 tw:py-2 tw:font-mono tw:text-2xs tw:tracking-[0.08em] tw:text-muted-foreground tw:uppercase">
              RFC 8628 device login
            </span>
            <span className="tw:border tw:border-border tw:px-3 tw:py-2 tw:font-mono tw:text-2xs tw:tracking-[0.08em] tw:text-muted-foreground tw:uppercase">
              Drizzle ORM
            </span>
          </div>
        </div>
        <IdentityCard density="compact">
          <IdentityEyebrow>AUTH / GOOGLE</IdentityEyebrow>
          <h2 className="tw:mt-12 tw:mb-3 tw:font-serif tw:text-[31px] tw:font-normal tw:tracking-[-0.035em]">
            워크스페이스에 로그인
          </h2>
          <p className="tw:text-[13px] tw:leading-[1.65] tw:text-muted-foreground">
            Google 계정으로 본인을 확인합니다. Google 액세스 토큰은 DopeDB에
            보관하지 않습니다.
          </p>
          {params.error ? (
            <IdentityError>
              {messages[params.error] ?? "로그인에 실패했습니다."}
            </IdentityError>
          ) : null}
          <SignInButton returnTo={returnTo} />
          <p className="tw:mt-4 tw:mb-0 tw:text-xs tw:text-muted-foreground">
            계속하면 조직의 워크스페이스 정책과 감사 기록 적용에 동의합니다.
          </p>
        </IdentityCard>
      </section>
      <footer className="tw:relative tw:z-[1] tw:flex tw:items-center tw:justify-between tw:border-t tw:border-border tw:pt-4 tw:font-mono tw:text-xs tw:tracking-[0.08em] tw:text-muted-foreground tw:uppercase">
        <span>DopeDB cloud control plane</span>
        <span className="tw:max-[800px]:hidden">Seoul · Virginia</span>
      </footer>
    </main>
  );
}
