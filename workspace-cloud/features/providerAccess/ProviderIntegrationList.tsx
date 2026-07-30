"use client";

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

  return (
    <>
      <div className="provider-catalog">
        {providers.map((provider) => {
          const connectedCount = integrations.filter(
            (item) => item.provider === provider.id,
          ).length;
          const available =
            provider.availability === "available" && provider.configured;
          return (
            <div className="provider-row" key={provider.id}>
              <div>
                <strong>{provider.name}</strong>
                <small>{provider.note}</small>
              </div>
              <div className="provider-row-actions ds-control-row">
                {connectedCount > 0 ? (
                  <span className="provider-state">
                    연결 {connectedCount}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={!available || mutation !== ""}
                  onClick={() => beginConnect(provider)}
                >
                  {provider.availability === "planned"
                    ? "준비 중"
                    : provider.configured
                      ? connectedCount > 0
                        ? "추가"
                        : "연결"
                      : "서버 설정 필요"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {setupProvider?.id === "neon" ? (
        <form
          className="provider-setup-form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect(setupProvider, neonConfiguration);
          }}
        >
          <p className="provider-setup-note">
            가능하면{" "}
            <a
              href="https://neon.com/docs/manage/api-keys"
              target="_blank"
              rel="noreferrer"
            >
              프로젝트 범위 조직 API 키
            </a>
            를 사용하세요.
          </p>
          <label>
            <span>Neon API 키</span>
            <input
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
          </label>
          <label>
            <span>조직 ID · 선택</span>
            <input
              value={neonConfiguration.organizationId}
              onChange={(event) =>
                setNeonConfiguration({
                  ...neonConfiguration,
                  organizationId: event.target.value,
                })
              }
              placeholder="org-..."
            />
          </label>
          <button type="submit" disabled={mutation !== ""}>
            검증 후 연결
          </button>
        </form>
      ) : null}

      {integrations.length > 0 ? (
        <div className="integration-list">
          {integrations.map((integration) => (
            <div className="integration-row" key={integration.id}>
              <div>
                <strong>{integration.displayName}</strong>
                <small>
                  관리형 서버 접근 · 마지막 확인{" "}
                  {new Date(integration.updatedAt).toLocaleString("ko-KR")}
                </small>
              </div>
              <button
                type="button"
                disabled={mutation !== ""}
                onClick={() => void disconnect(integration)}
              >
                연결 해제
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
