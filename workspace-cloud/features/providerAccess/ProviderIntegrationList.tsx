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
    gcpConfiguration,
    mutation,
    beginConnect,
    connect,
    disconnect,
    setGcpConfiguration,
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

      {setupProvider?.id === "gcpCloudSql" ? (
        <form
          className="provider-setup-form gcp"
          onSubmit={(event) => {
            event.preventDefault();
            void connect(setupProvider, gcpConfiguration);
          }}
        >
          <p className="provider-setup-note">
            서비스 계정 키 대신{" "}
            <a
              href="https://vercel.com/docs/oidc/gcp"
              target="_blank"
              rel="noreferrer"
            >
              Vercel OIDC·GCP WIF
            </a>
            를 먼저 설정하세요.
          </p>
          {(
            [
              ["projectId", "프로젝트 ID", "my-project-123"],
              ["projectNumber", "프로젝트 번호", "123456789012"],
              ["workloadIdentityPoolId", "WIF 풀 ID", "vercel-prod"],
              [
                "workloadIdentityProviderId",
                "WIF 공급자 ID",
                "dopedb-app",
              ],
              ["instanceId", "전용 Cloud SQL 인스턴스 ID", "prod-db"],
              [
                "readServiceAccountEmail",
                "읽기 서비스 계정",
                "dopedb-read@...",
              ],
              [
                "writeServiceAccountEmail",
                "쓰기 서비스 계정 · 선택",
                "dopedb-write@...",
              ],
            ] as const
          ).map(([key, label, placeholder]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type={key.includes("Email") ? "email" : "text"}
                value={gcpConfiguration[key]}
                onChange={(event) =>
                  setGcpConfiguration({
                    ...gcpConfiguration,
                    [key]: event.target.value,
                  })
                }
                placeholder={placeholder}
                required={key !== "writeServiceAccountEmail"}
              />
            </label>
          ))}
          <p className="provider-setup-note">
            두 서비스 계정의 <code>roles/cloudsql.instanceUser</code>와
            읽기 계정의 <code>roles/cloudsql.viewer</code> 바인딩은
            <code>
              resource.name == &apos;projects/
              {gcpConfiguration.projectId || "PROJECT_ID"}/instances/
              {gcpConfiguration.instanceId || "INSTANCE_ID"}&apos; &amp;&amp;
              resource.service == &apos;sqladmin.googleapis.com&apos;
            </code>{" "}
            조건으로 제한하세요. DopeDB는 impersonation과 대상 인스턴스는
            확인하지만 IAM 정책 조건식과 DB 내부 GRANT 전체를 대신 감사할
            수는 없습니다.
          </p>
          <label className="provider-confirmation">
            <input
              type="checkbox"
              checked={gcpConfiguration.dedicatedServiceAccountsConfirmed}
              onChange={(event) =>
                setGcpConfiguration({
                  ...gcpConfiguration,
                  dedicatedServiceAccountsConfirmed: event.target.checked,
                })
              }
              required
            />
            <span>
              인스턴스 전용 서비스 계정
              <small>
                이 계정들을 다른 Cloud SQL 인스턴스에서 재사용하지 않습니다.
              </small>
            </span>
          </label>
          <label className="provider-confirmation">
            <input
              type="checkbox"
              checked={gcpConfiguration.instanceScopedIamConfirmed}
              onChange={(event) =>
                setGcpConfiguration({
                  ...gcpConfiguration,
                  instanceScopedIamConfirmed: event.target.checked,
                })
              }
              required
            />
            <span>
              인스턴스 범위 IAM Condition
              <small>
                위 조건을 관련 Instance User·Viewer 바인딩에 적용했습니다.
              </small>
            </span>
          </label>
          <button type="submit" disabled={mutation !== ""}>
            설정 확인 후 연결
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
