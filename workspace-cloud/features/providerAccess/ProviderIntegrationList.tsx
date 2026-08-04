"use client";

import {
  ControlButton,
  ControlField,
  ControlInput,
} from "../../app/components/Controls";
import type { ProviderAccessController } from "./useProviderAccess";

export function ProviderIntegrationList({
  controller,
}: {
  controller: ProviderAccessController;
}) {
  const {
    providers,
    integrations,
    managedConnections,
    setupProvider,
    neonConfiguration,
    mutation,
    beginConnect,
    connect,
    disconnect,
    setNeonConfiguration,
  } = controller;
  return (
    <div className="tw:grid tw:content-start tw:gap-7">
      <section className="tw:grid tw:gap-2">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-xs tw:text-foreground">
            연결된 계정
          </strong>
          <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
            계정은 DB를 찾고 단기 자격증명을 발급하는 인증 경계입니다.
          </small>
        </div>
        <div className="tw:grid tw:border-t tw:border-border">
          {integrations.map((integration) => {
            const provider = providers.find(
              (item) => item.id === integration.provider,
            );
            const databaseCount = managedConnections.filter(
              (item) => item.integrationId === integration.id,
            ).length;
            return (
              <article
                className="tw:grid tw:min-h-[72px] tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-4 tw:border-b tw:border-border tw:py-3 tw:max-[640px]:grid-cols-1"
                key={integration.id}
              >
                <div className="tw:grid tw:min-w-0 tw:gap-1">
                  <span className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                    <strong className="tw:text-sm tw:text-foreground">
                      {integration.displayName}
                    </strong>
                    <span
                      className="tw:font-mono tw:text-2xs tw:uppercase tw:data-[status=active]:text-success tw:data-[status=reconnect_required]:text-danger"
                      data-status={integration.status}
                    >
                      {integration.status === "active"
                        ? "정상"
                        : "재연결 필요"}
                    </span>
                  </span>
                  <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                    공유 DB {databaseCount}개 · 마지막 확인{" "}
                    {new Date(integration.updatedAt).toLocaleString("ko-KR")}
                  </small>
                  {integration.provider === "neon"
                    && integration.grantedScope?.includes(":personal:broad:") ? (
                      <small className="tw:text-2xs tw:leading-body tw:text-danger">
                        개인 API 키는 계정 전체 권한을 가질 수 있습니다. 프로젝트
                        범위 조직 키로 다시 연결하는 것을 권장합니다.
                      </small>
                    ) : null}
                </div>
                <div className="tw:flex tw:flex-wrap tw:justify-end tw:gap-2 tw:max-[640px]:justify-start">
                  {provider ? (
                    <ControlButton
                      disabled={!provider.configured || mutation !== ""}
                      onClick={() => beginConnect(provider)}
                    >
                      다시 연결
                    </ControlButton>
                  ) : null}
                  <ControlButton
                    tone="danger"
                    disabled={mutation !== ""}
                    onClick={() => void disconnect(integration)}
                  >
                    연결 해제
                  </ControlButton>
                </div>
              </article>
            );
          })}
          {integrations.length === 0 ? (
            <p className="tw:m-0 tw:border-b tw:border-border tw:py-6 tw:text-2xs tw:text-muted-foreground">
              연결된 클라우드 계정이 없습니다.
            </p>
          ) : null}
        </div>
      </section>

      <section className="tw:grid tw:gap-2">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-xs tw:text-foreground">
            계정 연결
          </strong>
          <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
            현재 실제 관리형 연결을 지원하는 공급자만 표시합니다.
          </small>
        </div>
        <div className="tw:grid tw:border-t tw:border-border">
          {providers.map((provider) => {
            const connectedCount = integrations.filter(
              (item) => item.provider === provider.id,
            ).length;
            return (
              <div
                className="tw:grid tw:min-h-[78px] tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-4 tw:border-b tw:border-border tw:py-3 tw:max-[640px]:grid-cols-1"
                key={provider.id}
              >
                <div className="tw:grid tw:gap-1">
                  <span className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                    <strong className="tw:text-sm tw:text-foreground">
                      {provider.name}
                    </strong>
                    {provider.supportedEngines.map((engine) => (
                      <span
                        className="tw:border tw:border-border tw:bg-surface-inset tw:px-1.5 tw:py-0.5 tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground"
                        key={engine}
                      >
                        {engine}
                      </span>
                    ))}
                  </span>
                  <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                    {provider.note}
                  </small>
                </div>
                <div className="tw:flex tw:items-center tw:justify-end tw:gap-2 tw:max-[640px]:justify-start">
                  {connectedCount > 0 ? (
                    <span className="tw:font-mono tw:text-2xs tw:uppercase tw:text-primary">
                      {connectedCount}개 연결됨
                    </span>
                  ) : null}
                  <ControlButton
                    disabled={!provider.configured || mutation !== ""}
                    onClick={() => beginConnect(provider)}
                  >
                    {provider.configured
                      ? connectedCount > 0
                        ? "계정 추가"
                        : "계정 연결"
                      : "서버 설정 필요"}
                  </ControlButton>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {setupProvider?.id === "neon" ? (
        <form
          className="tw:grid tw:grid-cols-1 tw:items-end tw:gap-3 tw:border-y tw:border-border tw:py-4 tw:lg:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void connect(setupProvider, neonConfiguration);
          }}
        >
          <p className="tw:col-span-full tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
            Neon은 제3자 앱용 공개 OAuth 등록을 제공하지 않아 API 키로
            연결합니다. 원클릭 연결이 아니며, 가능하면{" "}
            <a
              className="tw:text-primary"
              href="https://neon.com/docs/manage/api-keys"
              target="_blank"
              rel="noreferrer"
            >
              프로젝트 범위 조직 API 키
            </a>
            를 만들어 사용하세요. 키는 서버에서 암호화되며 공유 DB에는
            저장되지 않습니다.
          </p>
          <ControlField label="Neon API 키">
            <ControlInput
              type="password"
              autoComplete="off"
              value={neonConfiguration.apiKey}
              onChange={(event) =>
                setNeonConfiguration({
                  ...neonConfiguration,
                  apiKey: event.target.value,
                })
              }
              placeholder="프로젝트 범위 API 키"
              required
            />
          </ControlField>
          <ControlField label="조직 ID · 선택">
            <ControlInput
              value={neonConfiguration.organizationId}
              onChange={(event) =>
                setNeonConfiguration({
                  ...neonConfiguration,
                  organizationId: event.target.value,
                })
              }
              placeholder="org-..."
            />
          </ControlField>
          <div className="tw:col-span-full tw:flex tw:justify-end">
            <ControlButton
              type="submit"
              tone="primary"
              size="field"
              disabled={mutation !== ""}
            >
              검증 후 연결
            </ControlButton>
          </div>
        </form>
      ) : null}
    </div>
  );
}
