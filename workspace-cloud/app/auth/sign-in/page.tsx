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
    <main
      className="tw:relative tw:grid tw:min-h-[100dvh] tw:grid-rows-[auto_minmax(0,1fr)_auto] tw:overflow-hidden tw:px-[clamp(22px,4vw,64px)] tw:py-[clamp(22px,3vw,42px)]"
      id="main-content"
    >
      <div className="tw:relative tw:z-[1] tw:flex tw:items-center tw:justify-between">
        <Brand />
        <span className="tw:inline-flex tw:items-center tw:gap-2 tw:rounded-full tw:border tw:border-border tw:bg-surface/80 tw:px-3 tw:py-2 tw:font-mono tw:text-2xs tw:font-medium tw:text-muted-foreground tw:backdrop-blur tw:max-[720px]:hidden">
          <i className="tw:size-1.5 tw:rounded-full tw:bg-success" />
          Control plane available
        </span>
      </div>
      <section className="tw:relative tw:z-[1] tw:m-auto tw:grid tw:w-[min(1280px,100%)] tw:grid-cols-[minmax(0,1.15fr)_minmax(380px,0.72fr)] tw:items-center tw:gap-[clamp(48px,8vw,120px)] tw:py-[clamp(68px,10vh,128px)] tw:max-[860px]:grid-cols-1 tw:max-[860px]:gap-12">
        <div>
          <IdentityEyebrow>SHARED ACCESS / PERSONAL AUTHORITY</IdentityEyebrow>
          <h1 className="tw:my-7 tw:max-w-[760px] tw:font-serif tw:text-[clamp(54px,6.4vw,92px)] tw:leading-[0.96] tw:font-normal tw:tracking-[-0.055em] tw:text-balance">
            DB 접근은 함께.
            <br />인증 정보는 각자.
          </h1>
          <p className="tw:max-w-[610px] tw:text-[17px] tw:leading-[1.8] tw:text-[var(--ds-text-secondary)]">
            워크스페이스는 연결과 정책을 공유하고, 장기 비밀값은 각 구성원의
            기기에 남깁니다. Agent도 승인된 하나의 DB 경계 안에서만 일합니다.
          </p>
          <dl className="tw:mt-12 tw:grid tw:grid-cols-3 tw:border-y tw:border-border tw:max-[640px]:grid-cols-1 tw:max-[640px]:border-b-0">
            {[
              ["Shared", "연결 · 정책"],
              ["Personal", "OS 자격 증명"],
              ["Managed", "15분 단기 권한"],
            ].map(([term, detail]) => (
              <div className="tw:border-r tw:border-border tw:px-4 tw:py-4 tw:first:pl-0 tw:last:border-r-0 tw:max-[640px]:border-r-0 tw:max-[640px]:border-b tw:max-[640px]:px-0" key={term}>
                <dt className="tw:font-mono tw:text-2xs tw:font-medium tw:tracking-[0.08em] tw:text-primary tw:uppercase">
                  {term}
                </dt>
                <dd className="tw:mt-2 tw:ml-0 tw:text-xs tw:text-muted-foreground">
                  {detail}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <IdentityCard density="compact">
          <IdentityEyebrow>SIGN IN / GOOGLE</IdentityEyebrow>
          <h2 className="tw:mt-10 tw:mb-3 tw:font-serif tw:text-[36px] tw:leading-tight tw:font-normal tw:tracking-[-0.035em] tw:text-balance tw:max-[480px]:text-[32px]">
            워크스페이스에 로그인
          </h2>
          <p className="tw:text-[14px] tw:leading-[1.75] tw:text-muted-foreground">
            Google 계정으로 본인을 확인합니다. Google 액세스 토큰은 DopeDB에
            보관하지 않습니다.
          </p>
          {params.error ? (
            <IdentityError>
              {messages[params.error] ?? "로그인에 실패했습니다."}
            </IdentityError>
          ) : null}
          <SignInButton returnTo={returnTo} />
          <p className="tw:mt-5 tw:mb-0 tw:text-2xs tw:leading-[1.7] tw:text-muted-foreground">
            Google로 계속하면{" "}
            <a
              href="https://dopedb.dev/ko/terms"
              target="_blank"
              rel="noreferrer"
              className="tw:font-medium tw:text-foreground tw:underline tw:underline-offset-2 tw:hover:text-primary"
            >
              서비스 이용약관
            </a>
            에 동의하고{" "}
            <a
              href="https://dopedb.dev/ko/privacy"
              target="_blank"
              rel="noreferrer"
              className="tw:font-medium tw:text-foreground tw:underline tw:underline-offset-2 tw:hover:text-primary"
            >
              개인정보처리방침
            </a>
            을 확인한 것으로 봅니다. 조직의 워크스페이스 정책과 감사 기록도
            적용됩니다.
          </p>
        </IdentityCard>
      </section>
      <footer className="tw:relative tw:z-[1] tw:flex tw:items-center tw:justify-between tw:border-t tw:border-border tw:pt-4 tw:font-mono tw:text-2xs tw:text-muted-foreground">
        <span>DopeDB workspace control plane</span>
        <span className="tw:max-[800px]:hidden">Seoul · Virginia</span>
      </footer>
    </main>
  );
}
