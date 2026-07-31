"use client";

import { useState } from "react";
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
  const [mobilePane, setMobilePane] = useState<"providers" | "connections">(
    "providers",
  );

  return (
    <section className="tw:grid tw:gap-4 tw:p-5">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-3">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-sm tw:text-foreground">
            공급자와 데이터베이스
          </strong>
          <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
            공급자 계정을 먼저 연결한 뒤 공유할 데이터베이스를 선택합니다.
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
        <div className="tw:grid tw:gap-4">
          {configuringGcp ? <GcpCloudSetup controller={controller} /> : null}
          <div className="tw:grid tw:gap-3">
            <div
              className="tw:grid tw:grid-cols-2 tw:border tw:border-border tw:bg-surface-inset tw:p-0.5 tw:md:hidden"
              role="tablist"
              aria-label="공급자 및 데이터베이스 연결"
            >
                <button
                  id="provider-accounts-tab"
                  className="tw:h-control-md tw:border-0 tw:bg-transparent tw:px-3 tw:text-2xs tw:font-semibold tw:text-muted-foreground tw:data-[selected=true]:bg-selection tw:data-[selected=true]:text-selection-foreground"
                  type="button"
                  role="tab"
                  aria-selected={mobilePane === "providers"}
                  aria-controls="provider-accounts-pane"
                  data-selected={mobilePane === "providers"}
                  onClick={() => setMobilePane("providers")}
                >
                  공급자 연결
                </button>
                <button
                  id="managed-connection-tab"
                  className="tw:h-control-md tw:border-0 tw:bg-transparent tw:px-3 tw:text-2xs tw:font-semibold tw:text-muted-foreground tw:data-[selected=true]:bg-selection tw:data-[selected=true]:text-selection-foreground"
                  type="button"
                  role="tab"
                  aria-selected={mobilePane === "connections"}
                  aria-controls="managed-connection-pane"
                  data-selected={mobilePane === "connections"}
                  onClick={() => setMobilePane("connections")}
                >
                  DB 연결
                </button>
            </div>

            <div className="tw:grid tw:min-w-0 tw:gap-0 tw:md:grid-cols-[minmax(280px,0.82fr)_minmax(0,1.4fr)] tw:md:border tw:md:border-border">
                <section
                  id="provider-accounts-pane"
                  className={
                    mobilePane === "providers"
                      ? "tw:grid tw:min-w-0 tw:content-start tw:gap-3 tw:border tw:border-border tw:p-4 tw:md:border-0 tw:md:border-r tw:md:border-border"
                      : "tw:hidden tw:min-w-0 tw:content-start tw:gap-3 tw:border tw:border-border tw:p-4 tw:md:grid tw:md:border-0 tw:md:border-r tw:md:border-border"
                  }
                  role="tabpanel"
                  aria-labelledby="provider-accounts-tab"
                >
                  <div className="tw:grid tw:gap-1">
                    <strong className="tw:text-xs tw:text-foreground">
                      연결 가능한 공급자
                    </strong>
                    <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                      현재 실제 연결을 지원하는 공급자만 표시합니다.
                    </small>
                  </div>
                  <ProviderIntegrationList controller={controller} />
                </section>

                <section
                  id="managed-connection-pane"
                  className={
                    mobilePane === "connections"
                      ? "tw:grid tw:min-w-0 tw:content-start tw:gap-3 tw:border tw:border-border tw:p-4 tw:md:border-0"
                      : "tw:hidden tw:min-w-0 tw:content-start tw:gap-3 tw:border tw:border-border tw:p-4 tw:md:grid tw:md:border-0"
                  }
                  role="tabpanel"
                  aria-labelledby="managed-connection-tab"
                >
                  <div className="tw:grid tw:gap-1">
                    <strong className="tw:text-xs tw:text-foreground">
                      데이터베이스 연결
                    </strong>
                    <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                      연결한 공급자에서 DB를 선택해 새 공유 연결로 가져오거나
                      기존 연결을 전환합니다.
                    </small>
                  </div>
                  <ProviderResourcePicker controller={controller} />
                </section>
            </div>
          </div>
        </div>
      )}
      {!configuringGcp && controller.error ? (
        <small className="tw:text-2xs tw:text-danger" role="alert">
          {controller.error}
        </small>
      ) : null}
    </section>
  );
}
