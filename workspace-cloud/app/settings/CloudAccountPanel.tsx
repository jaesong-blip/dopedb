"use client";

import { GcpCloudSetup } from "../../features/providerAccess/GcpCloudSetup";
import { ProviderIntegrationList } from "../../features/providerAccess/ProviderIntegrationList";
import { useProviderAccess } from "../../features/providerAccess/useProviderAccess";

export function CloudAccountPanel({
  workspaceId,
  gcpSetupId = null,
}: {
  workspaceId: string;
  gcpSetupId?: string | null;
}) {
  const controller = useProviderAccess(workspaceId, gcpSetupId);
  const configuringGcp = Boolean(controller.gcpSetupId);

  return (
    <section className="tw:grid tw:gap-5 tw:p-5">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-4 tw:max-[640px]:grid">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-sm tw:text-foreground">
            인증 계정
          </strong>
          <small className="tw:max-w-[44rem] tw:text-2xs tw:leading-body tw:text-muted-foreground">
            여기서는 공급자 인증만 관리합니다. 실제 팀 연결은 공유
            데이터베이스에서 별도로 추가합니다.
          </small>
        </div>
        <span className="tw:whitespace-nowrap tw:font-mono tw:text-2xs tw:uppercase tw:text-primary">
          장기 DB 암호 저장 없음
        </span>
      </header>

      {controller.loading ? (
        <p className="tw:m-0 tw:border-y tw:border-border tw:py-5 tw:text-2xs tw:text-muted-foreground">
          연결된 계정을 확인하는 중입니다.
        </p>
      ) : configuringGcp ? (
        <GcpCloudSetup controller={controller} />
      ) : (
        <ProviderIntegrationList controller={controller} />
      )}

      {!configuringGcp && controller.error ? (
        <p
          className="tw:m-0 tw:border tw:border-danger/40 tw:bg-danger/5 tw:px-3 tw:py-2 tw:text-2xs tw:leading-body tw:text-danger"
          role="alert"
        >
          {controller.error}
        </p>
      ) : null}
    </section>
  );
}
