"use client";

import { useState } from "react";
import { ControlButton, ControlLink } from "../components/Controls";
import { NeonBranchManager } from "../../features/providerAccess/NeonBranchManager";
import { ProviderResourcePicker } from "../../features/providerAccess/ProviderResourcePicker";
import { useProviderAccess } from "../../features/providerAccess/useProviderAccess";

export function SharedDatabasePanel({
  workspaceId,
  initialIntegrationId = null,
}: {
  workspaceId: string;
  initialIntegrationId?: string | null;
}) {
  const controller = useProviderAccess(
    workspaceId,
    null,
    initialIntegrationId,
  );
  const [adding, setAdding] = useState(Boolean(initialIntegrationId));
  const managedByConnection = new Map(
    controller.managedConnections.map((item) => [item.connectionId, item]),
  );

  return (
    <section className="tw:grid tw:gap-5 tw:p-5">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-4 tw:max-[640px]:grid">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-sm tw:text-foreground">
            워크스페이스 DB
          </strong>
          <small className="tw:max-w-[44rem] tw:text-2xs tw:leading-body tw:text-muted-foreground">
            한 번 등록한 DB는 팀에 공유되고, 허용된 멤버의 역할에 맞는 단기
            자격증명을 앱이 자동으로 회전합니다.
          </small>
        </div>
        <ControlButton
          tone={adding ? "neutral" : "primary"}
          onClick={() => setAdding((current) => !current)}
          disabled={controller.loading}
        >
          {adding ? "추가 닫기" : "DB 추가"}
        </ControlButton>
      </header>

      {adding ? (
        controller.integrations.length > 0 ? (
          <ProviderResourcePicker controller={controller} />
        ) : (
          <div className="tw:grid tw:gap-3 tw:border-y tw:border-border tw:py-5">
            <strong className="tw:text-xs tw:text-foreground">
              먼저 클라우드 계정을 연결하세요
            </strong>
            <p className="tw:m-0 tw:max-w-[42rem] tw:text-2xs tw:leading-body tw:text-muted-foreground">
              DopeDB가 프로젝트와 DB를 확인할 인증 계정이 아직 없습니다.
              계정을 연결한 뒤 이 화면으로 돌아오면 DB를 고를 수 있습니다.
            </p>
            <div>
              <ControlLink
                href={`/settings?workspace=${encodeURIComponent(workspaceId)}&section=cloud-accounts`}
                data-tone="primary"
              >
                클라우드 계정 연결
              </ControlLink>
            </div>
          </div>
        )
      ) : null}

      {!controller.loading ? (
        <NeonBranchManager
          workspaceId={workspaceId}
          integrations={controller.integrations}
          managedConnections={controller.managedConnections}
        />
      ) : null}

      {controller.loading ? (
        <p className="tw:m-0 tw:border-y tw:border-border tw:py-5 tw:text-2xs tw:text-muted-foreground">
          공유 데이터베이스를 확인하는 중입니다.
        </p>
      ) : (
        <div className="tw:grid tw:border-t tw:border-border">
          {controller.connections.map((connection) => {
            const managed = managedByConnection.get(connection.id);
            const provider = controller.providers.find(
              (item) => item.id === managed?.provider,
            );
            const target = managed && provider
              ? provider.resourceLevels
                .map((level) => managed.resource[level.key])
                .filter(Boolean)
                .join(" / ")
              : "";
            return (
              <article
                className="tw:grid tw:min-h-[72px] tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-4 tw:border-b tw:border-border tw:py-3 tw:max-[640px]:grid-cols-1"
                key={connection.id}
              >
                <div className="tw:grid tw:min-w-0 tw:gap-1">
                  <span className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                    <strong className="tw:text-sm tw:text-foreground">
                      {connection.name}
                    </strong>
                    <span className="tw:border tw:border-border tw:bg-surface-inset tw:px-1.5 tw:py-0.5 tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground">
                      {connection.engine}
                    </span>
                  </span>
                  <small className="tw:truncate tw:text-2xs tw:leading-body tw:text-muted-foreground tw:max-[640px]:whitespace-normal">
                    {managed && provider
                      ? `${provider.name} · ${target}`
                      : "멤버가 각자 로컬 자격증명을 입력하는 연결"}
                  </small>
                </div>
                <div className="tw:grid tw:justify-items-end tw:gap-1 tw:max-[640px]:justify-items-start">
                  <strong className="tw:font-mono tw:text-2xs tw:uppercase tw:text-primary">
                    {connection.credentialMode === "managed"
                      ? "역할 기반 자동 접근"
                      : "멤버 로컬"}
                  </strong>
                  <span className="tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2 tw:max-[640px]:justify-start">
                    <a
                      className="tw:text-2xs tw:text-muted-foreground tw:hover:text-foreground"
                      href={`/settings?workspace=${encodeURIComponent(workspaceId)}&section=database-access`}
                    >
                      접근 권한 관리
                    </a>
                    {connection.accessMode === "manage" ? (
                      <ControlButton
                        tone="danger"
                        onClick={() => void controller.deleteSharedConnection(connection)}
                        disabled={Boolean(controller.mutation)}
                      >
                        {controller.mutation === `delete-connection:${connection.id}`
                          ? "제거 중"
                          : "공유 DB 제거"}
                      </ControlButton>
                    ) : null}
                  </span>
                </div>
              </article>
            );
          })}
          {controller.connections.length === 0 ? (
            <div className="tw:border-b tw:border-border tw:py-10 tw:text-center">
              <strong className="tw:block tw:text-xs tw:text-foreground">
                아직 공유된 DB가 없습니다
              </strong>
              <small className="tw:mt-1 tw:block tw:text-2xs tw:text-muted-foreground">
                위의 DB 추가에서 연결할 대상을 선택하세요.
              </small>
            </div>
          ) : null}
        </div>
      )}

      {controller.error ? (
        <div
          className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:border tw:border-danger/40 tw:bg-danger/5 tw:px-3 tw:py-2 tw:max-[640px]:grid"
          role="alert"
        >
          <p className="tw:m-0 tw:text-2xs tw:leading-body tw:text-danger">
            {controller.error}
          </p>
          {controller.error.includes("다시 연결") ? (
            <ControlLink
              href={`/settings?workspace=${encodeURIComponent(workspaceId)}&section=cloud-accounts`}
            >
              클라우드 계정으로 이동
            </ControlLink>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
