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
    setupProvider,
    neonConfiguration,
    mutation,
    beginConnect,
    connect,
    disconnect,
    setNeonConfiguration,
  } = controller;
  const connectableProviders = providers.filter(
    (provider) => provider.availability === "available",
  );

  return (
    <div className="tw:grid tw:content-start tw:gap-4">
      <div className="tw:grid tw:border-t tw:border-border">
        {connectableProviders.map((provider) => {
          const connectedCount = integrations.filter(
            (item) => item.provider === provider.id,
          ).length;
          const available = provider.configured;
          return (
            <div
              className="tw:grid tw:min-h-[72px] tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border tw:py-2.5"
              key={provider.id}
            >
              <div className="tw:grid tw:gap-1">
                <strong className="tw:text-sm tw:text-foreground">
                  {provider.name}
                </strong>
                <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                  {provider.note}
                </small>
                <span className="tw:flex tw:flex-wrap tw:gap-1.5">
                  {provider.supportedEngines.map((engine) => (
                    <span
                      className="tw:border tw:border-border tw:bg-surface-inset tw:px-1.5 tw:py-0.5 tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground"
                      key={engine}
                    >
                      {engine}
                    </span>
                  ))}
                </span>
              </div>
              <div className="tw:flex tw:items-center tw:justify-end tw:gap-2">
                {connectedCount > 0 ? (
                  <span className="tw:whitespace-nowrap tw:font-mono tw:text-2xs tw:uppercase tw:text-primary">
                    연결 {connectedCount}
                  </span>
                ) : null}
                <ControlButton
                  disabled={!available || mutation !== ""}
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

      {setupProvider?.id === "neon" ? (
        <form
          className="tw:grid tw:grid-cols-1 tw:items-end tw:gap-3 tw:lg:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void connect(setupProvider, neonConfiguration);
          }}
        >
          <p className="tw:col-span-full tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
            가능하면{" "}
            <a
              className="tw:text-primary"
              href="https://neon.com/docs/manage/api-keys"
              target="_blank"
              rel="noreferrer"
            >
              프로젝트 범위 조직 API 키
            </a>
            를 사용하세요.
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

      {integrations.length > 0 ? (
        <div className="tw:grid tw:border-t tw:border-border">
          {integrations.map((integration) => (
            <div
              className="tw:grid tw:min-h-[58px] tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border tw:py-2"
              key={integration.id}
            >
              <div className="tw:grid tw:gap-1">
                <strong className="tw:text-sm tw:text-foreground">
                  {integration.displayName}
                </strong>
                <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                  관리형 서버 접근 · 마지막 확인{" "}
                  {new Date(integration.updatedAt).toLocaleString("ko-KR")}
                </small>
              </div>
              <ControlButton
                tone="danger"
                disabled={mutation !== ""}
                onClick={() => void disconnect(integration)}
              >
                연결 해제
              </ControlButton>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
