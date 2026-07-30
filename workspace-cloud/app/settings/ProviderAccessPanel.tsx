"use client";

import { ProviderIntegrationList } from "../../features/providerAccess/ProviderIntegrationList";
import { ProviderResourcePicker } from "../../features/providerAccess/ProviderResourcePicker";
import { GcpCloudSetup } from "../../features/providerAccess/GcpCloudSetup";
import { useProviderAccess } from "../../features/providerAccess/useProviderAccess";

export {
  canUseLocalProviderCredential,
  providerImportDisplayName,
  selectableProviderResources,
} from "../../features/providerAccess/domain";

export function ProviderAccessPanel({
  workspaceId,
  gcpSetupId = null,
}: {
  workspaceId: string;
  gcpSetupId?: string | null;
}) {
  const controller = useProviderAccess(workspaceId, gcpSetupId);
  const configuringGcp = Boolean(controller.gcpSetupId);

  return (
    <section className="tw:grid tw:gap-4 tw:border-t tw:border-border tw:p-5">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-3">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-sm tw:text-foreground">관리형 DB 접근</strong>
          <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
            구성원별 최소 권한 자격증명을 15분 동안만 발급합니다.
          </small>
        </div>
        <span className="tw:whitespace-nowrap tw:font-mono tw:text-2xs tw:uppercase tw:text-primary">
          장기 DB 암호 저장 없음
        </span>
      </header>

      {controller.loading ? (
        <p className="tw:m-0 tw:py-5 tw:text-2xs tw:leading-body tw:text-muted-foreground">
          공급자 설정을 확인하는 중입니다.
        </p>
      ) : (
        <>
          {configuringGcp ? (
            <GcpCloudSetup controller={controller} />
          ) : (
            <>
              <ProviderIntegrationList controller={controller} />
              <ProviderResourcePicker controller={controller} />
            </>
          )}
        </>
      )}
      {!configuringGcp && controller.error ? (
        <small className="form-error" role="alert">
          {controller.error}
        </small>
      ) : null}
    </section>
  );
}
