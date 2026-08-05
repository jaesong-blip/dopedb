import { Brand } from "../../../components/Brand";
import {
  IdentityBody,
  IdentityCard,
  IdentityEyebrow,
  IdentitySingleShell,
  IdentityTitle,
} from "../../../components/Identity";

export default async function DeviceCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const denied = Boolean((await searchParams).denied);
  return (
    <IdentitySingleShell>
      <Brand />
      <div className="tw:m-auto tw:w-[min(540px,100%)]">
        <IdentityCard>
          <div className="tw:mb-9 tw:grid tw:size-[54px] tw:place-items-center tw:rounded-surface tw:bg-success tw:text-[23px] tw:text-[var(--ds-text-inverse)]">
            {denied ? "×" : "✓"}
          </div>
          <IdentityEyebrow>
            {denied ? "DEVICE DENIED" : "DEVICE AUTHORIZED"}
          </IdentityEyebrow>
          <IdentityTitle>
            {denied ? "요청을 거절했습니다." : "연결되었습니다."}
          </IdentityTitle>
          <IdentityBody>
            DopeDB 앱으로 돌아가세요. 이 브라우저 창은 닫아도 됩니다.
          </IdentityBody>
        </IdentityCard>
      </div>
    </IdentitySingleShell>
  );
}
