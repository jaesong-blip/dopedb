"use client";

import { ProviderIntegrationList } from "../../features/providerAccess/ProviderIntegrationList";
import { ProviderResourcePicker } from "../../features/providerAccess/ProviderResourcePicker";
import { useProviderAccess } from "../../features/providerAccess/useProviderAccess";

export {
  canUseLocalProviderCredential,
  providerImportDisplayName,
  selectableProviderResources,
} from "../../features/providerAccess/domain";

export function ProviderAccessPanel({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const controller = useProviderAccess(workspaceId);

  return (
    <section className="provider-access-panel">
      <header className="provider-access-heading">
        <div>
          <strong>관리형 DB 접근</strong>
          <small>구성원별 최소 권한 자격증명을 15분 동안만 발급합니다.</small>
        </div>
        <span>장기 DB 암호 저장 없음</span>
      </header>

      {controller.loading ? (
        <p className="provider-empty">공급자 설정을 확인하는 중입니다.</p>
      ) : (
        <>
          <ProviderIntegrationList controller={controller} />
          <ProviderResourcePicker controller={controller} />
        </>
      )}
      {controller.error ? (
        <small className="form-error" role="alert">
          {controller.error}
        </small>
      ) : null}
    </section>
  );
}
