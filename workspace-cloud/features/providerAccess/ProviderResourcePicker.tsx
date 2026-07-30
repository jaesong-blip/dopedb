"use client";

import {
  ControlButton,
  ControlField,
  ControlSelect,
} from "../../app/components/Controls";
import { selectableProviderResources } from "./domain";
import type { ProviderAccessController } from "./useProviderAccess";

export function ProviderResourcePicker({
  controller,
}: {
  controller: ProviderAccessController;
}) {
  const {
    integrations,
    connections,
    selectedConnectionId,
    selectedIntegrationId,
    selection,
    resourceOptions,
    resourcePending,
    mutation,
    selectedConnection,
    selectedIntegration,
    selectedProvider,
    resourceComplete,
    currentResourceLabel,
    mayUseLocalProviderCredential,
    willReplaceConnection,
    importDiscoveredResource,
    resetResources,
    selectResource,
    setSelectedConnectionId,
    setSelectedIntegrationId,
    switchToMemberLocal,
  } = controller;

  return (
    <div className="tw:grid tw:grid-cols-1 tw:gap-3 tw:lg:grid-cols-2">
      <ControlField label="1 · 전환할 공유 연결">
        <ControlSelect
          value={selectedConnectionId}
          onChange={(event) => {
            setSelectedConnectionId(event.target.value);
            resetResources();
          }}
          disabled={connections.length === 0}
        >
          {connections.length === 0 ? (
            <option value="">공유된 DB가 없습니다</option>
          ) : null}
          {connections.map((connection) => (
            <option value={connection.id} key={connection.id}>
              {connection.name} · {connection.engine} ·{" "}
              {connection.credentialMode === "managed"
                ? "자동 발급"
                : "개별 입력"}
            </option>
          ))}
        </ControlSelect>
      </ControlField>
      <ControlField label="2 · 공급자 계정">
        <ControlSelect
          value={selectedIntegrationId}
          onChange={(event) => {
            setSelectedIntegrationId(event.target.value);
            resetResources();
          }}
          disabled={integrations.length === 0}
        >
          {integrations.length === 0 ? (
            <option value="">먼저 공급자를 연결하세요</option>
          ) : null}
          {integrations.map((integration) => (
            <option
              value={integration.id}
              key={integration.id}
              disabled={integration.status !== "active"}
            >
              {integration.displayName}
              {integration.status === "reconnect_required"
                ? " · reconnect required"
                : ""}
            </option>
          ))}
        </ControlSelect>
      </ControlField>
      <div
        className={
          selectedProvider?.id === "gcpCloudSql"
            ? "tw:col-span-full tw:grid tw:grid-cols-1 tw:gap-3 tw:sm:grid-cols-2 tw:xl:grid-cols-4"
            : "tw:col-span-full tw:grid tw:grid-cols-1 tw:gap-3 tw:sm:grid-cols-2 tw:xl:grid-cols-3"
        }
      >
        {selectedProvider?.resourceLevels.map((level, index) => {
          const isFinalLeaf =
            index === selectedProvider.resourceLevels.length - 1;
          const options = selectableProviderResources(
            resourceOptions[level.key] ?? [],
            isFinalLeaf,
            selectedProvider.supportedEngines,
          );
          const previous =
            index === 0 ||
            Boolean(
              selection[selectedProvider.resourceLevels[index - 1].key],
          );
          return (
            <ControlField
              key={level.key}
              label={
                <>
                {index === 0 ? "3 · " : ""}
                {level.label}
                </>
              }
            >
              <ControlSelect
                value={selection[level.key] ?? ""}
                onChange={(event) =>
                  void selectResource(index, event.target.value)
                }
                disabled={
                  !selectedIntegration || !previous || resourcePending
                }
              >
                <option value="">선택</option>
                {options.map((item) => (
                  <option value={item.value} key={item.id}>
                    {item.name}
                    {item.production === true
                      ? " · production"
                      : item.production === "unknown"
                        ? " · classification pending"
                        : item.ready === false
                          ? " · not ready"
                    : ""}
                  </option>
                ))}
              </ControlSelect>
            </ControlField>
          );
        })}
      </div>
      <div className="tw:col-span-full tw:grid tw:gap-3 tw:border-t tw:border-border tw:pt-3 tw:xl:grid-cols-[minmax(0,1fr)_auto] tw:xl:items-center">
        <p className="tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
          {!selectedIntegration
            ? "상단에서 GCP Cloud SQL, Neon 또는 PlanetScale 공급자 연결을 먼저 완료하세요. 이 선택기는 연결 주소 편집이 아니라 관리형 접근 전환에 사용됩니다."
            : currentResourceLabel
            ? `현재 ${currentResourceLabel}에 자동 연결됩니다.`
            : willReplaceConnection
              ? "선택한 공유 연결의 ID와 대시보드는 유지하고, 구성원별 비밀번호를 단기 관리형 접근으로 교체합니다."
            : selectedConnection?.allowWrites
              ? "멤버 RBAC에 따라 읽기 또는 읽기·쓰기 권한을 발급합니다."
              : "이 연결은 모든 구성원에게 읽기 전용 자격증명만 발급합니다."}
        </p>
        <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2">
          {mayUseLocalProviderCredential ? (
            <div className="tw:grid tw:max-w-[36rem] tw:gap-2 tw:border tw:border-border tw:bg-surface-inset tw:p-3">
              <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                이 가져온 공급자 대상만 구성원 로컬 자격증명으로 전환할 수
                있습니다. 대상·읽기 전용 정책은 유지되며 자격증명은 이
                기기에만 저장됩니다.
              </small>
              <ControlButton
                disabled={mutation !== ""}
                onClick={() => void switchToMemberLocal()}
              >
                로컬 Provider 자격증명 사용
              </ControlButton>
            </div>
          ) : null}
          <ControlButton
            tone="primary"
            disabled={
              !selectedIntegration ||
              !resourceComplete ||
              resourcePending ||
              mutation !== ""
            }
            onClick={() => void importDiscoveredResource()}
          >
            {mutation.startsWith("import:")
              ? willReplaceConnection
                ? "전환하는 중"
                : "가져오는 중"
              : !selectedIntegration
                ? "공급자 연결 필요"
              : willReplaceConnection
                ? "선택 연결을 관리형으로 전환"
                : "읽기 전용 연결 가져오기"}
          </ControlButton>
        </div>
      </div>
    </div>
  );
}
